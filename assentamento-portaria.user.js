// ==UserScript==
// @name         Assentamentos - Lançamento a partir da foto da Portaria
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Lê a foto da portaria (OCR), monta os lançamentos (licença-prêmio 35, revogação 353) e lança em Assentamentos Normais > Inclusão do e-cidade.
// @match        https://ecidade.saoborja.rs.gov.br/*
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================================
    // CONFIGURAÇÕES DE TEMPO
    // =========================================================================
    const TEMPO_LOOP = 1000;
    const TEMPO_ESPERA_CAMPO = 300;        // após preencher um campo, antes de conferir
    const TEMPO_LIMITE = 15000;            // limite das esperas dinâmicas (popup, carregamento)
    const TEMPO_LIMITE_INCLUIR = 20000;    // limite para a inclusão ser confirmada
    const TEMPO_LIMITE_ASSENT = 8000;      // limite para o código do assentamento carregar a descrição
    const TEMPO_LIMITE_REDE = 10000;       // espera o e-cidade terminar as requisições (AJAX) da tela
    const TEMPO_REDE_PARADA = 500;         // sem requisições por esse tempo = e-cidade terminou de carregar
    const TENTATIVAS_REPETIR = 3;          // erro interno / conferência: tentativas no mesmo lançamento

    // Campos da tela achados pelo rótulo. Só preencha se o "🔎 Diagnóstico" mostrar que precisa
    // forçar um seletor (ex: dataIni: '#h16_dtconc').
    const SELETORES = {
        codigo: null, nome: null, afastCodigo: null, dataIni: null, dataFim: null, quantidade: null,
        quantDias: null, numeroAto: null, tipoAto: null, anoAto: null, historico: null, incluir: null
    };

    // Chaves do localStorage (prefixo próprio para não conflitar com o robô do Plano de Saúde)
    const K_STATUS = 'ecas_status';
    const K_ITENS = 'ecas_itens';
    const K_INDEX = 'ecas_index';
    const K_LOG = 'ecas_log';
    const K_ALERTA = 'ecas_alerta';
    const K_AUTO = 'ecas_auto_incluir';
    const K_TEXTO = 'ecas_texto_lido';
    const K_PORTARIA = 'ecas_portaria';
    const K_AVISOS = 'ecas_avisos';
    const K_TENTATIVAS = 'ecas_tentativas';

    // =========================================================================
    // <<NUCLEO>> LEITURA DA PORTARIA E REGRAS DE NEGÓCIO (funções puras, sem DOM)
    // =========================================================================
    const CODIGO_LICENCA = '35';     // LICENCA PREMIO (gozo)
    const CODIGO_REVOGACAO = '353';  // revogação de portaria
    const TIPO_ATO = 'PORTARIA';
    const PARTICULAS = ['DE', 'DA', 'DO', 'DOS', 'DAS', 'E', 'D'];
    const MESES = {
        janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7,
        agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12
    };
    const D = '(\\d{2}\\/\\d{2}\\/\\d{4})';
    // Palavras que aparecem em maiúsculas no texto mas não são nome de servidor
    const NAO_NOME = ['LICENCA', 'PREMIO', 'ASSIDUIDADE', 'CONCEDER', 'CONCEDE', 'SERVIDOR', 'SERVIDORA',
        'SERVIDORES', 'PORTARIA', 'PREFEITO', 'RESOLVE', 'ART'];

    function normalizarNome(nome) {
        return (nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Tira acentos sem mudar o tamanho do texto (é -> e), para usar os índices das buscas no original
    function semAcento(texto) {
        return texto.replace(/[^\u0000-\u007f]/g, c => {
            let base = c.normalize('NFD').charAt(0);
            return base.length === 1 ? base : c;
        });
    }

    // Junta quebras de linha e corrige ruídos comuns de OCR (travessões, espaços dentro de datas)
    function limparTexto(texto) {
        return (texto || '').replace(/[–—‑−]/g, '-')
            .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
            .replace(/\s+/g, ' ').trim();
    }

    const UNIDADES = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze',
        'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
    const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
    const CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos',
        'oitocentos', 'novecentos'];

    function porExtenso(n) {
        n = parseInt(n, 10);
        if (!(n > 0 && n < 1000)) return String(n);
        if (n === 100) return 'cem';
        let partes = [];
        let c = Math.floor(n / 100);
        let r = n % 100;
        if (c) partes.push(CENTENAS[c]);
        if (r >= 20) {
            partes.push(DEZENAS[Math.floor(r / 10)] + (r % 10 ? ' e ' + UNIDADES[r % 10] : ''));
        } else if (r) {
            partes.push(UNIDADES[r]);
        }
        return partes.join(' e ');
    }

    function paraData(texto) {
        let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((texto || '').trim());
        if (!m) return null;
        let d = +m[1], mes = +m[2], a = +m[3];
        let t = Date.UTC(a, mes - 1, d);
        let dt = new Date(t);
        if (dt.getUTCDate() !== d || dt.getUTCMonth() !== mes - 1) return null;
        return { d, m: mes, a, t };
    }

    function diasEntre(ini, fim) {
        let a = paraData(ini), b = paraData(fim);
        return a && b ? Math.round((b.t - a.t) / 86400000) + 1 : null;
    }

    function doisDigitos(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function gerarHistorico(it) {
        if (it.tipo !== 'licenca') return it.historico || '';
        return `Concede Licença-prêmio por assiduidade a(o) servidor(a), matrícula ${it.matriculaTexto}, que poderá gozar ` +
            `${it.dias} (${porExtenso(it.dias)}) dias de licença-prêmio, a contar de ${it.dataIni} até ${it.dataFim}, ` +
            `referente ao período aquisitivo de ${it.aqIni} a ${it.aqFim}.\nEsta Portaria entra em vigor nesta data.` +
            (it.protocolo ? `\nProtocolo Web: ${it.protocolo}.` : '');
    }

    function novoItem(base) {
        return Object.assign({
            tipo: 'licenca', codigo: CODIGO_LICENCA, nome: '', matriculaTexto: '', matriculaSistema: '',
            dataIni: '', dataFim: '', dias: '', aqIni: '', aqFim: '', protocolo: '', numeroAto: '', anoAto: '',
            tipoAto: TIPO_ATO, historico: '', historicoManual: false, artigo: '', aviso: '', situacao: ''
        }, base);
    }

    // Nome do servidor: primeiro trecho em MAIÚSCULAS (2+ palavras) seguido de vírgula
    function acharNome(trechoSemAcento) {
        let re = /([A-Z][A-Z']+(?: +[A-Z'][A-Z']*)+)\s*,/g;
        let m;
        while ((m = re.exec(trechoSemAcento))) {
            let nome = m[1].replace(/^(?:X{0,2}(?:IX|IV|V?I{1,3}|V|X))\s+(?=[A-Z]{2})/, '');
            let palavras = nome.split(/\s+/);
            if (palavras.length >= 2 && !palavras.some(p => NAO_NOME.includes(p))) {
                return { inicio: m.index + (m[1].length - nome.length), tamanho: nome.length };
            }
        }
        return null;
    }

    function dataDoCabecalho(t) {
        let cab = /PORTARIA\s*N\S{0,3}\s*(\d[\d.\s]*?)\s*,?\s*DE\s+(\d{1,2})\s*[º°o]?\s+DE\s+([A-Za-z]+)\s+DE\s+(\d{4})/i.exec(t);
        if (cab && MESES[cab[3].toLowerCase()]) {
            return { numero: cab[1].replace(/\D/g, ''), data: `${doisDigitos(+cab[2])}/${doisDigitos(MESES[cab[3].toLowerCase()])}/${cab[4]}`, ano: cab[4] };
        }
        let r = { numero: '', data: '', ano: '' };
        let num = /PORTARIA\s*N\S{0,3}\s*(\d[\d.]*)/i.exec(t);
        if (num) r.numero = num[1].replace(/\D/g, '');
        let datas = [];
        let re = /(\d{1,2})\s*[º°o]?\s+de\s+([a-z]+)\s+de\s+(\d{4})/gi;
        let m;
        while ((m = re.exec(t))) if (MESES[m[2].toLowerCase()]) datas.push(m);
        let ult = datas[datas.length - 1];
        if (ult) {
            r.data = `${doisDigitos(+ult[1])}/${doisDigitos(MESES[ult[2].toLowerCase()])}/${ult[3]}`;
            r.ano = ult[3];
        }
        return r;
    }

    function acharProtocolos(t) {
        let protocolos = [];
        let re = /protocolad/gi;
        let m;
        while ((m = re.exec(t))) {
            let resto = t.slice(m.index);
            let fim = resto.slice(12).search(/consideran|resolve|art\.?\s*\d/i);
            let trecho = fim >= 0 ? resto.slice(0, fim + 12) : resto.slice(0, 300);
            let rp = /(\d{3,7})\s*\/\s*(\d{4}|\d{2})(?!\d)/g;
            let p;
            while ((p = rp.exec(trecho))) protocolos.push(`${p[1]}/${p[2].length === 2 ? '20' + p[2] : p[2]}`);
        }
        return protocolos;
    }

    // Itens de concessão: cada servidor tem um "matrícula nº"; o nome vem antes dele
    function itensDeConcessao(orig, t, inicioArtigo, artigo) {
        let itens = [];
        let posicoes = [];
        let re = /matricula/gi;
        let m;
        while ((m = re.exec(t))) posicoes.push(m.index);
        let inicioCabeca = 0;
        posicoes.forEach((p, i) => {
            let cabeca = t.slice(inicioCabeca, p);
            let corpo = t.slice(p, i + 1 < posicoes.length ? posicoes[i + 1] : t.length);
            let nome = acharNome(cabeca);
            let it = novoItem({ artigo });
            if (nome) it.nome = orig.substr(inicioCabeca + nome.inicio, nome.tamanho).toUpperCase().trim();
            let mat = /^matricula\s*(?:n\S{0,2})?\s*(\d[\d.]*)/i.exec(corpo);
            if (mat) it.matriculaTexto = mat[1].replace(/\D/g, '');
            let dias = /(\d{1,3})\s*\([^)]{2,30}\)\s*dias/i.exec(corpo) || /(\d{1,3})\s*dias/i.exec(corpo);
            if (dias) it.dias = parseInt(dias[1], 10);
            let gozo = new RegExp(`periodo\\s+de\\s+${D}\\s+(?:a|ate)\\s+${D}`, 'i').exec(corpo) ||
                new RegExp(`a\\s+contar\\s+de\\s+${D}\\s+(?:a|ate)\\s+${D}`, 'i').exec(corpo);
            if (gozo) { it.dataIni = gozo[1]; it.dataFim = gozo[2]; }
            let aq = new RegExp(`aquisitivo\\s+de\\s+${D}\\s+(?:a|ate)\\s+${D}`, 'i').exec(corpo);
            if (aq) { it.aqIni = aq[1]; it.aqFim = aq[2]; }
            let ultimo = aq || gozo || dias;
            inicioCabeca = p + (ultimo ? ultimo.index + ultimo[0].length : 9);
            itens.push(it);
        });
        return itens;
    }

    // Recebe o texto lido da foto (OCR) e devolve a portaria e os lançamentos
    function parsearPortaria(bruto) {
        let orig = limparTexto(bruto);
        let t = semAcento(orig);
        let cab = dataDoCabecalho(t);
        let r = { numeroAto: cab.numero, anoAto: cab.ano, dataPortaria: cab.data, protocolos: acharProtocolos(t), itens: [], avisos: [] };

        let base = Math.max(0, t.search(/RESOLVE/i));
        let marcas = [];
        let re = /\bArt\.?\s*(\d{1,2})\s*[º°o]?\s*[.:-]?\s*/gi;
        re.lastIndex = base;
        let m;
        while ((m = re.exec(t))) marcas.push({ n: m[1], inicio: m.index, corpo: m.index + m[0].length });

        marcas.forEach((mk, k) => {
            let fim = k + 1 < marcas.length ? marcas[k + 1].inicio : t.length;
            let tc = t.slice(mk.corpo, fim);
            let oc = orig.slice(mk.corpo, fim);
            let lc = tc.toLowerCase();
            let outroTema = /pecunia|indeniza|venda|vender|iptu|abatimento|conversao|converter/.test(lc);
            if (/revog/.test(lc)) {
                let nome = /servidor(?:a|\(a\))?\s+([A-Za-zÀ-ÿ' ]+?)\s*(?:[,.;]|$)/i.exec(oc);
                if (nome) {
                    r.itens.push(novoItem({
                        tipo: 'revogacao', codigo: CODIGO_REVOGACAO, nome: nome[1].toUpperCase().trim(), artigo: mk.n,
                        dataIni: r.dataPortaria, dataFim: r.dataPortaria, dias: 1, historico: oc.trim()
                    }));
                } else if (/portaria\s*n?\S{0,2}\s*\d/.test(lc)) {
                    r.avisos.push(`Art. ${mk.n}: revogação sem nome de servidor — confira à mão: "${oc.trim().slice(0, 160)}"`);
                }
                return;
            }
            if (/licen\S{0,3}\s*-?\s*premio/.test(lc) && /goz/.test(lc) && /matricula/.test(lc) && !outroTema) {
                itensDeConcessao(oc, tc, mk.corpo, mk.n).forEach(it => r.itens.push(it));
                return;
            }
            if (/matricula|servidor/.test(lc)) {
                let it = novoItem({ tipo: 'pulado', codigo: '', artigo: mk.n, historico: oc.trim() });
                let nome = acharNome(tc);
                if (nome) it.nome = oc.substr(nome.inicio, nome.tamanho).toUpperCase();
                it.aviso = `Art. ${mk.n}: tema não é gozo de licença-prêmio nem revogação` +
                    (outroTema ? ' (venda/conversão de licença, IPTU ou similar)' : '') + ` — pulado: "${oc.trim().slice(0, 160)}"`;
                r.itens.push(it);
            }
        });

        let licencas = r.itens.filter(it => it.tipo === 'licenca');
        licencas.forEach((it, i) => { it.protocolo = r.protocolos[i] || ''; });
        if (r.protocolos.length !== licencas.length) {
            r.avisos.push(`A portaria tem ${r.protocolos.length} protocolo(s) para ${licencas.length} servidor(es) — confira a coluna Protocolo`);
        }
        r.itens.forEach(it => {
            if (it.tipo === 'pulado') return;
            it.numeroAto = r.numeroAto;
            it.anoAto = r.anoAto;
            if (it.tipo === 'licenca') it.historico = gerarHistorico(it);
        });
        return r;
    }

    // Problemas que impedem lançar o item (vazio = pode lançar)
    function validarItem(it) {
        if (it.tipo === 'pulado') return [];
        let p = [];
        if (!normalizarNome(it.nome) && !/^\d+$/.test(it.matriculaSistema || '')) p.push('nome do servidor');
        if (!it.codigo) p.push('código do assentamento');
        let ini = paraData(it.dataIni), fim = paraData(it.dataFim);
        if (!ini) p.push('data inicial');
        if (!fim) p.push('data final');
        if (ini && fim && fim.t < ini.t) p.push('data final antes da inicial');
        let dias = parseInt(it.dias, 10);
        if (!(dias > 0)) p.push('dias');
        else if (ini && fim && diasEntre(it.dataIni, it.dataFim) !== dias) p.push(`dias (${dias}) ≠ período (${diasEntre(it.dataIni, it.dataFim)})`);
        if (!/^\d+$/.test(it.numeroAto || '')) p.push('número do ato');
        if (!/^\d{4}$/.test(it.anoAto || '')) p.push('ano do ato');
        if (it.tipo === 'licenca') {
            if (!it.matriculaTexto) p.push('matrícula do texto');
            if (!paraData(it.aqIni) || !paraData(it.aqFim)) p.push('período aquisitivo');
        }
        if (!(it.historico || '').trim()) p.push('histórico');
        return p;
    }

    function semData(texto) {
        return !/\d/.test(texto || '');
    }

    // Escolhe o cadastro do servidor entre os resultados da pesquisa (mesmo nome):
    // 1 cadastro -> ele; senão o único sem data de rescisão; senão o que condiz com o período aquisitivo
    // (admissão no mesmo dia/mês do início do aquisitivo; senão o único admitido antes dele)
    function escolherCadastro(cands, it) {
        const lista = cs => cs.map(c => `${c.matricula} (adm. ${c.admissao || '?'}${semData(c.rescisao) ? '' : ', rescisão ' + c.rescisao})`).join(', ');
        if (!cands.length) return { erro: 'nenhum cadastro com esse nome' };
        if (cands.length === 1) return { linha: cands[0], motivo: 'único cadastro' };
        let ativos = cands.filter(c => semData(c.rescisao));
        if (ativos.length === 1) return { linha: ativos[0], motivo: 'único sem data de rescisão' };
        if (!ativos.length) return { erro: `todos os ${cands.length} cadastros têm data de rescisão: ${lista(cands)}` };
        let aq = paraData(it.aqIni);
        if (!aq) return { erro: `${ativos.length} cadastros sem data de rescisão e sem período aquisitivo para desempatar: ${lista(ativos)}` };
        let aniversario = ativos.filter(c => {
            let a = paraData(c.admissao);
            return a && a.d === aq.d && a.m === aq.m && a.t <= aq.t;
        });
        if (aniversario.length === 1) return { linha: aniversario[0], motivo: `admissão ${aniversario[0].admissao} condiz com o aquisitivo ${it.aqIni}` };
        if (aniversario.length > 1) return { erro: `mais de um cadastro condiz com o período aquisitivo ${it.aqIni}: ${lista(aniversario)}` };
        let anteriores = ativos.filter(c => { let a = paraData(c.admissao); return a && a.t <= aq.t; });
        if (anteriores.length === 1) return { linha: anteriores[0], motivo: `único admitido antes do aquisitivo ${it.aqIni}` };
        return { erro: `não deu para decidir pelo período aquisitivo ${it.aqIni} entre ${lista(ativos)}` };
    }
    // <<FIM NUCLEO>>

    // =========================================================================
    // COMPARAÇÃO DE NOMES (igual ao robô do Plano de Saúde)
    // =========================================================================
    function nomesCompativeis(nomeA, nomeB) {
        let a = normalizarNome(nomeA).split(' ');
        let b = normalizarNome(nomeB).split(' ');
        if (!a[0] || a[0] !== b[0]) return false;

        function casa(i, j) {
            if (i === a.length && j === b.length) return true;
            if (i < a.length && PARTICULAS.includes(a[i]) && casa(i + 1, j)) return true;
            if (j < b.length && PARTICULAS.includes(b[j]) && casa(i, j + 1)) return true;
            if (i === a.length || j === b.length) return false;
            if (a[i] === b[j]) return casa(i + 1, j + 1);
            if (b[j].length === 1 && a[i].startsWith(b[j])) return casa(i + 1, j + 1);
            if (j === b.length - 1 && i === a.length - 1 && b[j].length >= 3 && a[i].startsWith(b[j])) return true;
            return false;
        }
        return casa(0, 0);
    }

    function distanciaEdicao(a, b) {
        let ant = [];
        for (let j = 0; j <= b.length; j++) ant.push(j);
        for (let i = 1; i <= a.length; i++) {
            let atual = [i];
            for (let j = 1; j <= b.length; j++) {
                atual[j] = Math.min(ant[j] + 1, atual[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            ant = atual;
        }
        return ant[b.length];
    }

    function termosParecidos(a, b) {
        if (a === b) return true;
        if (a.length === 1 || b.length === 1) return a[0] === b[0];
        return a.length >= 5 && b.length >= 5 && distanciaEdicao(a, b) <= 1;
    }

    function nomesSemelhantes(nomeA, nomeB) {
        let a = normalizarNome(nomeA).split(' ').filter(t => !PARTICULAS.includes(t));
        let b = normalizarNome(nomeB).split(' ').filter(t => !PARTICULAS.includes(t));
        if (!a[0] || a[0] !== b[0]) return false;
        let comuns = a.slice(1).filter(t => t.length > 1 && b.slice(1).some(u => u.length > 1 && termosParecidos(t, u))).length;
        return comuns >= 2;
    }

    function nomeContido(curto, longo) {
        let a = normalizarNome(curto).split(' ').filter(t => !PARTICULAS.includes(t));
        let b = normalizarNome(longo).split(' ').filter(t => !PARTICULAS.includes(t));
        if (a.length < 2 || a.length >= b.length) return false;
        if (a[0] !== b[0]) return false;
        let j = 0;
        for (let t of a) {
            while (j < b.length && !termosParecidos(t, b[j])) j++;
            if (j === b.length) return false;
            j++;
        }
        return true;
    }

    function nomesBatem(a, b) {
        let na = normalizarNome(a);
        let nb = normalizarNome(b);
        if (!na || !nb) return false;
        if (na === nb) return true;
        if (Math.min(na.length, nb.length) >= 20 && (na.startsWith(nb) || nb.startsWith(na))) return true;
        return nomesCompativeis(a, b) || nomesCompativeis(b, a) || nomeContido(a, b) || nomeContido(b, a) || nomesSemelhantes(a, b);
    }

    // =========================================================================
    // OCR (Tesseract.js)
    // =========================================================================
    // A Prototype.js do e-cidade deixa métodos enumeráveis em Array.prototype e troca o Array.from;
    // durante o OCR os métodos ficam não-enumeráveis e o Array.from volta a ser o nativo
    async function semInterferenciaPrototype(fn) {
        let chaves = [];
        for (let k in Array.prototype) chaves.push(k); // eslint-disable-line guard-for-in
        chaves.forEach(k => Object.defineProperty(Array.prototype, k, { enumerable: false }));
        let fromOriginal = Array.from;
        let iframe = null;
        try {
            iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            document.body.appendChild(iframe);
            Array.from = iframe.contentWindow.Array.from;
        } catch (e) { /* segue com o Array.from atual */ }
        try {
            return await fn();
        } finally {
            Array.from = fromOriginal;
            if (iframe) iframe.remove();
            chaves.forEach(k => Object.defineProperty(Array.prototype, k, { enumerable: true }));
        }
    }

    // Desenha a foto num canvas (respeita a rotação do celular) e amplia fotos pequenas
    async function prepararImagem(arquivo) {
        try {
            let bmp = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
            let escala = Math.max(bmp.width, bmp.height) < 1800 ? 2 : 1;
            let canvas = document.createElement('canvas');
            canvas.width = bmp.width * escala;
            canvas.height = bmp.height * escala;
            let ctx = canvas.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
            return canvas;
        } catch (e) {
            return arquivo;
        }
    }

    async function lerFoto() {
        let arquivo = document.getElementById('ecas-foto').files[0];
        if (!arquivo) { alertaPainel('Selecione a foto da portaria.'); return; }
        let T = window.Tesseract || (typeof Tesseract !== 'undefined' ? Tesseract : null); // eslint-disable-line no-undef
        if (!T) { alertaPainel('Biblioteca de OCR (Tesseract.js) não carregou. Verifique o @require do script ou cole o texto.'); return; }
        try {
            mostrarAtual('Preparando a foto...');
            let imagem = await prepararImagem(arquivo);
            let r = await semInterferenciaPrototype(() => T.recognize(imagem, 'por', {
                logger: m => { if (m && m.status) mostrarAtual(`OCR: ${m.status} ${Math.round((m.progress || 0) * 100)}%`); }
            }));
            carregarTexto(r.data.text);
        } catch (e) {
            console.error(e);
            alertaPainel('Erro ao ler a foto: ' + (e && e.message ? e.message : e) + '\nTente colar o texto da portaria no campo do painel.');
            mostrarAtual('Erro no OCR');
        }
    }

    function carregarTexto(texto) {
        let r = parsearPortaria(texto);
        localStorage.setItem(K_TEXTO, texto);
        localStorage.setItem(K_ITENS, JSON.stringify(r.itens));
        localStorage.setItem(K_PORTARIA, JSON.stringify({ numeroAto: r.numeroAto, anoAto: r.anoAto, dataPortaria: r.dataPortaria, protocolos: r.protocolos }));
        localStorage.setItem(K_INDEX, '0');
        localStorage.setItem(K_STATUS, 'parado');
        localStorage.setItem(K_LOG, '[]');
        localStorage.setItem(K_AVISOS, '[]');
        localStorage.removeItem(K_TENTATIVAS);

        registrarLog('info', '-', `Portaria nº ${r.numeroAto || '?'} de ${r.dataPortaria || '?'} — protocolos: ${r.protocolos.join(', ') || 'nenhum'}`);
        let qtd = tipo => r.itens.filter(it => it.tipo === tipo).length;
        registrarLog('info', '-', `Lançamentos: ${qtd('licenca')} licença(s)-prêmio (35), ${qtd('revogacao')} revogação(ões) (353), ${qtd('pulado')} pulado(s)`);
        r.avisos.forEach(a => { registrarLog('aviso', '-', a); registrarAviso('-', '', a); });
        r.itens.forEach((it, i) => {
            if (it.tipo === 'pulado') return;
            let p = validarItem(it);
            if (p.length) registrarLog('aviso', `#${i + 1}`, `${it.nome || '?'}: confira ${p.join(', ')}`);
        });
        mostrarAtual('Texto lido. Confira os lançamentos (📝) antes de iniciar.');
        atualizarPainel();
        abrirConferencia();
    }

    // =========================================================================
    // FUNÇÕES AUXILIARES DE DOM
    // =========================================================================
    const esperar = ms => new Promise(r => setTimeout(r, ms));
    const REGEX_ALERTA_ERRO = /erro|inv[aá]lid|obrigat|n[aã]o foi|n[aã]o pode|falha|j[aá] existe|j[aá] cadastrad|n[aã]o encontrad|n[aã]o permitid/i;
    const REGEX_ALERTA_SUCESSO = /sucesso|inclu[ií]d|efetuad|gravad|salv[oa]/i;
    const REGEX_ERRO_SISTEMA = /uncaught exception|call to a member function|fatal error|stack trace|exception '|on line \d+|\.php\b|erro interno/i;

    // Pausa "boa": o robô preencheu e espera o usuário revisar e clicar em Incluir
    class PausaRevisao extends Error {}

    // Falha passageira: o robô repete o mesmo lançamento (até TENTATIVAS_REPETIR) e depois pausa
    class Repetir extends Error {}
    class ErroSistema extends Repetir {}
    class ConferenciaFalhou extends Repetir {}

    function ehErroDoSistema(msg) {
        return !!msg && REGEX_ERRO_SISTEMA.test(msg);
    }

    function relancarErroSistema(err) {
        if (err instanceof ErroSistema) throw err;
    }

    function checarParada() {
        if (localStorage.getItem(K_STATUS) !== 'rodando') throw new Error('Interrompido pelo usuário (⏸ Parar)');
    }

    // Espera dinâmica: reavalia a condição a cada mudança no DOM e a cada 200 ms
    function esperarAte(condicao, descricao, timeout = TEMPO_LIMITE) {
        return new Promise((resolve, reject) => {
            let terminado = false;
            let observador = null;
            let intervalo = null;
            let limite = null;
            const encerrar = () => {
                terminado = true;
                if (observador) observador.disconnect();
                clearInterval(intervalo);
                clearTimeout(limite);
            };
            const checar = () => {
                if (terminado) return;
                let alerta = espiarAlerta();
                if (ehErroDoSistema(alerta)) {
                    encerrar();
                    reject(new ErroSistema(alerta));
                    return;
                }
                let r = null;
                try { r = condicao(); } catch (e) { r = null; }
                if (r) { encerrar(); resolve(r); }
            };
            intervalo = setInterval(checar, 200);
            limite = setTimeout(() => {
                if (terminado) return;
                encerrar();
                reject(new Error('Tempo esgotado aguardando: ' + descricao));
            }, timeout);
            try {
                observador = new MutationObserver(checar);
                observador.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
            } catch (e) { /* sem observer, fica só o polling */ }
            checar();
        });
    }

    // Conta as requisições AJAX em andamento na tela (XMLHttpRequest e fetch)
    function instalarContadorRede(win) {
        try {
            if (!win || win.__ecasRede) return;
            let estado = { pendentes: 0 };
            win.__ecasRede = estado;
            let proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
            if (proto && proto.send) {
                let enviar = proto.send;
                proto.send = function() {
                    let terminou = false;
                    const fim = () => { if (!terminou) { terminou = true; estado.pendentes--; } };
                    estado.pendentes++;
                    try { this.addEventListener('loadend', fim); } catch (e) { fim(); }
                    try { return enviar.apply(this, arguments); } catch (e) { fim(); throw e; }
                };
            }
            if (typeof win.fetch === 'function') {
                let buscar = win.fetch;
                win.fetch = function() {
                    const fim = () => { estado.pendentes--; };
                    estado.pendentes++;
                    try {
                        let p = buscar.apply(this || win, arguments);
                        p.then(fim, fim);
                        return p;
                    } catch (e) { fim(); throw e; }
                };
            }
        } catch (e) { /* sem contador: as esperas viram só o limite de tempo */ }
    }
    instalarContadorRede(window);

    function requisicoesPendentes() {
        return window.__ecasRede ? window.__ecasRede.pendentes : 0;
    }

    async function esperarRedeOciosa() {
        let paradaDesde = null;
        await esperarAte(() => {
            if (requisicoesPendentes() > 0) { paradaDesde = null; return false; }
            if (paradaDesde === null) paradaDesde = Date.now();
            return Date.now() - paradaDesde >= TEMPO_REDE_PARADA;
        }, 'o e-cidade terminar de carregar', TEMPO_LIMITE_REDE).catch(relancarErroSistema);
    }

    function textoNorm(texto) {
        return (texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/\s+/g, ' ').trim();
    }

    // Rótulo comparável: sem acento, sem ":" no fim e sem espaço em volta de "/" ("Afast / Assent:")
    function rotuloNorm(texto) {
        return textoNorm(texto).replace(/:$/, '').replace(/\s*\/\s*/g, '/').trim();
    }

    function dispararEventos(elemento) {
        elemento.dispatchEvent(new Event('input', { bubbles: true }));
        elemento.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function preencherCampo(elemento, valor) {
        elemento.focus();
        elemento.value = '';
        dispararEventos(elemento);
        elemento.value = valor;
        dispararEventos(elemento);
        elemento.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        elemento.dispatchEvent(new Event('blur', { bubbles: true }));
        elemento.blur();
    }

    // Campo de data do e-cidade: além do visível, pode ter os ocultos _dia/_mes/_ano
    function preencherData(elemento, data) {
        preencherCampo(elemento, data);
        let [d, m, a] = data.split('/');
        let base = elemento.id || elemento.name;
        if (!base) return;
        [['_dia', d], ['_mes', m], ['_ano', a]].forEach(([suf, v]) => {
            let oculto = elemento.ownerDocument.getElementById(base + suf) || elemento.ownerDocument.getElementsByName(base + suf)[0];
            if (oculto) oculto.value = v;
        });
    }

    function editavel(el) {
        return !!el && !el.readOnly && !el.disabled;
    }

    function visivel(el) {
        return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    }

    function documentosAcessiveis() {
        let lista = [];
        const visitar = doc => {
            if (!doc || lista.includes(doc)) return;
            lista.push(doc);
            for (let f of doc.querySelectorAll('iframe, frame')) {
                try { visitar(f.contentDocument); } catch (e) { /* outro domínio */ }
            }
        };
        visitar(document);
        try { visitar(window.top.document); } catch (e) { /* topo inacessível */ }
        return lista;
    }

    function frameVisivel(doc) {
        if (doc === document) return true;
        try {
            let frame = doc.defaultView && doc.defaultView.frameElement;
            return !frame || visivel(frame);
        } catch (e) {
            return false;
        }
    }

    // =========================================================================
    // CAPTURA DE ALERT (todas as janelas acessíveis, inclusive o popup de pesquisa)
    // =========================================================================
    function instalarCapturaAlerta(win) {
        try {
            if (!win || win.__ecasAlertaOriginal) return;
            let original = win.alert;
            win.alert = function(msg) {
                if (localStorage.getItem(K_STATUS) === 'rodando') {
                    localStorage.setItem(K_ALERTA, String(msg));
                    console.log('[Robô Assentamentos] alert capturado:', msg);
                    return;
                }
                return original.call(win, msg);
            };
            win.__ecasAlertaOriginal = original;
        } catch (e) { /* janela inacessível */ }
    }
    instalarCapturaAlerta(window);
    const alertOriginal = window.__ecasAlertaOriginal || window.alert;

    function protegerAlertasDosFrames() {
        documentosAcessiveis().forEach(d => instalarCapturaAlerta(d.defaultView));
    }

    // Janela de erro do e-cidade em HTML ("Uncaught exception ...") com botão OK
    function acharDialogoErro() {
        for (let d of documentosAcessiveis()) {
            let botoes = Array.from(d.querySelectorAll('button, input[type=button], input[type=submit], a'))
                .filter(b => visivel(b) && !b.closest('#painel-ecas, #conferencia-ecas') && textoNorm(b.value || b.textContent) === 'ok');
            for (let b of botoes) {
                let el = b.parentElement;
                for (let n = 0; el && el !== d.body && n < 6; n++, el = el.parentElement) {
                    let texto = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (texto.length > 2000) break;
                    if (ehErroDoSistema(texto)) return { botao: b, mensagem: texto.replace(/\s*ok$/i, '') };
                }
            }
        }
        return null;
    }

    let ultimaBuscaDialogo = 0;
    function dispensarDialogoErro() {
        if (localStorage.getItem(K_STATUS) !== 'rodando') return;
        let agora = Date.now();
        if (agora - ultimaBuscaDialogo < 250) return;
        ultimaBuscaDialogo = agora;
        let dialogo = acharDialogoErro();
        if (!dialogo) return;
        console.log('[Robô Assentamentos] janela de erro do e-cidade (OK dado):', dialogo.mensagem);
        try { dialogo.botao.click(); } catch (e) { /* janela já fechada */ }
        localStorage.setItem(K_ALERTA, dialogo.mensagem);
    }

    function espiarAlerta() {
        dispensarDialogoErro();
        return localStorage.getItem(K_ALERTA);
    }

    function lerAlerta() {
        let a = localStorage.getItem(K_ALERTA);
        localStorage.removeItem(K_ALERTA);
        return a;
    }

    function alertaPainel(msg) {
        alertOriginal.call(window, msg);
    }

    // =========================================================================
    // LOCALIZAÇÃO DOS ELEMENTOS (por legenda do fieldset e rótulo do campo)
    // =========================================================================
    function fieldsetPorLegenda(legenda, doc = document) {
        let alvo = textoNorm(legenda);
        return Array.from(doc.querySelectorAll('fieldset')).find(fs => {
            let lg = Array.from(fs.children).find(c => c.tagName === 'LEGEND');
            return lg && textoNorm(lg.textContent) === alvo && visivel(fs);
        }) || null;
    }

    // Acha o rótulo (td/th/label) com o texto e devolve os campos que vêm depois dele na mesma linha
    function camposAposRotulo(escopo, rotulo) {
        if (!escopo) return [];
        let alvo = rotuloNorm(rotulo);
        let rotulos = Array.from(escopo.querySelectorAll('td, th, label'))
            .filter(el => rotuloNorm(el.textContent) === alvo && !el.querySelector('input, select, textarea'));
        for (let r of rotulos) {
            let celula = r.closest('td, th') || r;
            let linha = celula.closest('tr');
            let candidatos = linha ? Array.from(linha.querySelectorAll('input, select, textarea')) : [];
            if (!linha && r.htmlFor) {
                let el = escopo.ownerDocument.getElementById(r.htmlFor);
                if (el) candidatos = [el];
            }
            let depois = candidatos.filter(c => (celula.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) &&
                !['hidden', 'button', 'submit'].includes(c.type));
            if (depois.length) return depois;
        }
        return [];
    }

    function botaoNoDoc(doc, texto) {
        let alvo = textoNorm(texto);
        return Array.from(doc.querySelectorAll('input[type=button], input[type=submit], button'))
            .find(b => visivel(b) && textoNorm(b.value || b.textContent) === alvo && !b.closest('#painel-ecas, #conferencia-ecas')) || null;
    }

    // Lê uma tabela: acha a linha de cabeçalho com as colunas pedidas e devolve as linhas seguintes
    // como objetos { 'matricula': ..., _tr, _cel }
    function colunaCanonica(texto) {
        return textoNorm(texto).replace(/[▲▼]/g, '').trim();
    }

    function lerTabela(escopo, colunasObrigatorias) {
        if (!escopo) return null;
        let trs = Array.from(escopo.querySelectorAll('tr'));
        let iCab = trs.findIndex(tr => {
            let textos = Array.from(tr.cells).map(c => colunaCanonica(c.textContent));
            return colunasObrigatorias.every(col => textos.includes(col));
        });
        if (iCab < 0) return null;
        let trCab = trs[iCab];
        let cab = Array.from(trCab.cells).map(c => colunaCanonica(c.textContent));
        let tabelaCab = trCab.closest('table');
        let linhas = [];
        for (let tr of trs.slice(iCab + 1)) {
            let minimo = tr.closest('table') === tabelaCab ? 2 : cab.length;
            if (tr.cells.length < minimo || tr.querySelector('table')) continue;
            let obj = { _tr: tr, _cel: {} };
            let algumTexto = false;
            cab.forEach((col, i) => {
                let celula = tr.cells[i];
                if (!celula) return;
                obj[col] = (celula.textContent || '').replace(/\s+/g, ' ').trim();
                obj._cel[col] = celula;
                if (obj[col]) algumTexto = true;
            });
            if (algumTexto) linhas.push(obj);
        }
        return linhas;
    }

    function porSeletor(chave) {
        let s = SELETORES[chave];
        return s ? document.querySelector(s) : null;
    }

    function telaAssentamento() {
        let fs = fieldsetPorLegenda('Assentamentos');
        return !!(fs && camposAposRotulo(fs, 'Afast/Assent').length);
    }

    function elementosForm() {
        let fs = fieldsetPorLegenda('Assentamentos');
        let servidor = camposAposRotulo(fs, 'Servidor');
        let afast = camposAposRotulo(fs, 'Afast/Assent');
        let fsHist = fieldsetPorLegenda('Histórico');
        let link = fs ? Array.from(fs.querySelectorAll('a')).find(a => rotuloNorm(a.textContent) === 'servidor') : null;
        return {
            fieldset: fs,
            linkServidor: link,
            lancamento: camposAposRotulo(fs, 'Lançamento').find(c => c.tagName === 'SELECT') || null,
            codigo: porSeletor('codigo') || servidor[0] || null,
            nome: porSeletor('nome') || servidor[1] || null,
            afastCodigo: porSeletor('afastCodigo') || afast.find(c => c.tagName === 'INPUT') || null,
            afastSelects: afast.filter(c => c.tagName === 'SELECT'),
            dataIni: porSeletor('dataIni') || camposAposRotulo(fs, 'Data inicial')[0] || null,
            dataFim: porSeletor('dataFim') || camposAposRotulo(fs, 'Data final')[0] || null,
            quantidade: porSeletor('quantidade') || camposAposRotulo(fs, 'Quantidade')[0] || null,
            quantDias: porSeletor('quantDias') || camposAposRotulo(fs, 'Quant. dias')[0] || null,
            numeroAto: porSeletor('numeroAto') || camposAposRotulo(fs, 'Número ato')[0] || null,
            tipoAto: porSeletor('tipoAto') || camposAposRotulo(fs, 'Tipo ato')[0] || null,
            anoAto: porSeletor('anoAto') || camposAposRotulo(fs, 'Ano ato')[0] || null,
            historico: porSeletor('historico') || (fsHist || fs || document).querySelector('textarea'),
            incluir: porSeletor('incluir') || botaoNoDoc(document, 'Incluir')
        };
    }

    function exigirCampos(obj, chaves, contexto) {
        let faltando = chaves.filter(k => !obj[k]);
        if (faltando.length) {
            throw new Error(`${contexto}: não encontrei na tela: ${faltando.join(', ')} (envie o 🔎 Diagnóstico)`);
        }
    }

    // =========================================================================
    // SERVIDOR: PESQUISA POR NOME E ESCOLHA DO CADASTRO
    // =========================================================================
    function acharPopupPesquisa() {
        return documentosAcessiveis().find(d => d !== document && d.body && frameVisivel(d) &&
            fieldsetPorLegenda('Pesquisa de Servidores', d)) || null;
    }

    function lerResultados(doc) {
        let linhas = lerTabela(doc.body, ['matricula', 'nome/razao social']);
        if (!linhas) return null;
        return linhas.filter(l => /^\d+$/.test(l['matricula'] || '')).map(l => ({
            matricula: l['matricula'],
            nome: l['nome/razao social'] || '',
            admissao: l['admissao'] || '',
            rescisao: l['data da rescisao'] || '',
            _l: l
        }));
    }

    function assinaturaResultados(doc) {
        let linhas = doc ? lerResultados(doc) : null;
        return linhas ? linhas.map(l => l.matricula).join('|') : '';
    }

    function fecharPopupPesquisa() {
        let d = acharPopupPesquisa();
        if (!d) return;
        try {
            let fechar = botaoNoDoc(d, 'Fechar');
            if (fechar) fechar.click();
        } catch (e) { /* já fechou */ }
    }

    function servidorNaTela(matricula, nome) {
        let f = elementosForm();
        if (!f.codigo || !f.nome || !f.codigo.value.trim() || !f.nome.value.trim()) return false;
        if (matricula && f.codigo.value.trim() !== String(matricula)) return false;
        return !nome || nomesBatem(f.nome.value, nome);
    }

    // Variações de busca: nome inteiro; sem acento; primeiro + último; primeiro + segundo
    function termosDeBusca(nome) {
        let partes = normalizarNome(nome).split(' ').filter(Boolean);
        let termos = [nome.trim(), normalizarNome(nome)];
        if (partes.length > 2) termos.push(partes[0] + ' ' + partes[partes.length - 1], partes[0] + ' ' + partes[1]);
        return termos.filter((t, i) => t && termos.indexOf(t) === i);
    }

    async function pesquisarNoPopup(termo, it) {
        let pop = acharPopupPesquisa();
        if (!pop) {
            let f = elementosForm();
            exigirCampos(f, ['linkServidor', 'codigo', 'nome'], 'Servidor');
            f.codigo.value = '';
            f.nome.value = '';
            f.linkServidor.click();
            pop = await esperarAte(() => acharPopupPesquisa(), 'abrir a "Pesquisa de Servidores"');
            protegerAlertasDosFrames();
        }
        let campo = camposAposRotulo(pop.body, 'Nome/Razão Social')[0];
        let pesquisar = botaoNoDoc(pop, 'Pesquisar');
        if (!campo || !pesquisar) throw new Error('Pesquisa de Servidores: não achei o campo Nome/Razão Social ou o botão Pesquisar (envie o 🔎 Diagnóstico)');
        let antes = assinaturaResultados(pop);
        pop.__ecasVelho = true;
        preencherCampo(campo, termo);
        pesquisar.click();
        const condicao = aceitarAntigo => {
            if (servidorNaTela(null, it.nome) && !acharPopupPesquisa()) return { auto: true };
            let d = acharPopupPesquisa();
            if (!d) return null;
            let c = camposAposRotulo(d.body, 'Nome/Razão Social')[0];
            if (!c || normalizarNome(c.value) !== normalizarNome(termo)) return null;
            if (!aceitarAntigo && d.__ecasVelho && assinaturaResultados(d) === antes) return null;
            let linhas = lerResultados(d);
            if (linhas && linhas.length) return { doc: d, linhas };
            if (/nenhum registro|retornados 0 registro|nao foram encontrad|nao ha registro/.test(textoNorm(d.body.textContent))) return { doc: d, linhas: [] };
            return null;
        };
        try {
            return await esperarAte(() => condicao(false), `o resultado da pesquisa "${termo}"`);
        } catch (e) {
            relancarErroSistema(e);
            let r = condicao(true);
            if (r) return r;
            throw e;
        }
    }

    function clicarResultado(linha) {
        let celula = linha._l._cel['matricula'] || linha._l._tr.cells[0];
        let alvo = celula.querySelector('a') || linha._l._tr.querySelector('a') || celula;
        alvo.click();
    }

    async function carregarPorMatricula(matricula, it) {
        fecharPopupPesquisa();
        let f = elementosForm();
        exigirCampos(f, ['codigo', 'nome'], 'Servidor');
        f.nome.value = '';
        preencherCampo(f.codigo, String(matricula));
        await esperarAte(() => servidorNaTela(matricula), `carregar a matrícula ${matricula}`).catch(relancarErroSistema);
        f = elementosForm();
        if (!servidorNaTela(matricula)) throw new Error(`Matrícula ${matricula} não carregou na tela`);
        if (normalizarNome(it.nome) && !nomesBatem(f.nome.value, it.nome)) {
            throw new Error(`A matrícula ${matricula} é de "${f.nome.value}", não de "${it.nome}" — corrija a coluna "Matrícula e-cidade" (📝)`);
        }
        return String(matricula);
    }

    async function selecionarServidor(it, itens, indice) {
        // Matrícula informada na conferência, ou já achada para o mesmo servidor (ex: revogação depois da licença)
        let conhecida = it.matriculaSistema ||
            (itens.slice(0, indice).find(o => o.matriculaSistema && o.tipo !== 'pulado' && nomesBatem(o.nome, it.nome)) || {}).matriculaSistema;
        if (conhecida) return carregarPorMatricula(conhecida, it);

        let rotulo = `"${it.nome}"`;
        let tentados = [];
        for (let termo of termosDeBusca(it.nome)) {
            checarParada();
            mostrarAtual(`${it.nome}: pesquisando "${termo}"...`);
            let r = await pesquisarNoPopup(termo, it);
            if (r.auto) {
                let f = elementosForm();
                registrarLog('info', f.codigo.value, `${rotulo}: pesquisa trouxe um único cadastro (${f.codigo.value} - ${f.nome.value})`);
                return f.codigo.value.trim();
            }
            let texto = textoNorm(r.doc.body.textContent);
            let total = texto.match(/retornados (\d+) registro/);
            let ate = texto.match(/mostrando de \d+ ate (\d+)/);
            if (total && ate && parseInt(ate[1], 10) < parseInt(total[1], 10)) {
                fecharPopupPesquisa();
                throw new Error(`${rotulo}: a pesquisa "${termo}" trouxe ${total[1]} registros em várias páginas — informe a matrícula do e-cidade na conferência (📝)`);
            }
            let cands = r.linhas.filter(l => nomesBatem(l.nome, it.nome));
            tentados.push(`"${termo}": ${r.linhas.length} resultado(s)`);
            if (!cands.length) continue;
            let escolha = escolherCadastro(cands, it);
            if (escolha.erro) {
                fecharPopupPesquisa();
                throw new Error(`${rotulo}: ${escolha.erro}. Informe a matrícula certa na coluna "Matrícula e-cidade" (📝) e use ▶ Iniciar`);
            }
            clicarResultado(escolha.linha);
            await esperarAte(() => servidorNaTela(escolha.linha.matricula), `a matrícula ${escolha.linha.matricula} voltar para a tela`).catch(relancarErroSistema);
            if (!servidorNaTela(escolha.linha.matricula)) throw new Error(`${rotulo}: cliquei na matrícula ${escolha.linha.matricula}, mas ela não voltou para a tela`);
            registrarLog('info', escolha.linha.matricula, `${rotulo}: escolhido ${escolha.linha.matricula} (${escolha.motivo})`);
            return escolha.linha.matricula;
        }
        fecharPopupPesquisa();
        throw new Error(`${rotulo}: servidor não encontrado na pesquisa (${tentados.join('; ')}). Corrija o nome ou informe a matrícula do e-cidade (📝)`);
    }

    // =========================================================================
    // FORMULÁRIO: PREENCHIMENTO, CONFERÊNCIA E INCLUSÃO
    // =========================================================================
    function textoOpcao(select) {
        let o = select && select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
        return o ? o.text.trim() : '';
    }

    function assentamentoConfere(codigo) {
        let f = elementosForm();
        let codigoOk = (f.afastCodigo && f.afastCodigo.value.trim() === codigo) ||
            f.afastSelects.some(s => s.value.trim() === codigo || textoOpcao(s) === codigo);
        if (!codigoOk) return false;
        let descricao = f.afastSelects.map(textoOpcao).find(t => t && !/^\d+$/.test(t)) || '';
        if (!descricao || /selecione/i.test(descricao)) return false;
        if (codigo === CODIGO_LICENCA && !/licen.{0,3}a\s*premio/.test(textoNorm(descricao))) return false;
        return descricao;
    }

    async function preencherAssentamento(codigo) {
        let f = elementosForm();
        if (f.afastCodigo) preencherCampo(f.afastCodigo, codigo);
        let ok = await esperarAte(() => assentamentoConfere(codigo), `o assentamento ${codigo} carregar`, TEMPO_LIMITE_ASSENT)
            .catch(e => { relancarErroSistema(e); return null; });
        if (ok) return ok;
        // Plano B: escolhe o código direto na lista
        for (let s of elementosForm().afastSelects) {
            let opcao = Array.from(s.options).find(o => o.value.trim() === codigo || o.text.trim() === codigo || o.text.trim().startsWith(codigo + ' '));
            if (opcao) { s.value = opcao.value; dispararEventos(s); }
        }
        ok = await esperarAte(() => assentamentoConfere(codigo), `o assentamento ${codigo} carregar`, TEMPO_LIMITE_ASSENT)
            .catch(e => { relancarErroSistema(e); return null; });
        if (!ok) {
            let desc = elementosForm().afastSelects.map(textoOpcao).join(' / ');
            throw new ConferenciaFalhou(`Conferência falhou: Afast/Assent deveria ser ${codigo}${codigo === CODIGO_LICENCA ? ' - LICENCA PREMIO' : ''}, mas a tela mostra "${desc}"`);
        }
        return ok;
    }

    function historicoNorm(texto) {
        return (texto || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
    }

    function conferirFormulario(it) {
        let f = elementosForm();
        const falha = msg => { throw new ConferenciaFalhou('Conferência falhou: ' + msg); };
        if (f.codigo.value.trim() !== String(it.matriculaSistema)) falha(`servidor ${it.matriculaSistema}, tela mostra "${f.codigo.value}"`);
        if (!assentamentoConfere(it.codigo)) falha(`Afast/Assent ${it.codigo}, tela mostra "${f.afastSelects.map(textoOpcao).join(' / ')}"`);
        if (f.dataIni.value.trim() !== it.dataIni) falha(`Data inicial ${it.dataIni}, tela mostra "${f.dataIni.value}"`);
        if (f.dataFim.value.trim() !== it.dataFim) falha(`Data final ${it.dataFim}, tela mostra "${f.dataFim.value}"`);
        for (let [campo, nomeCampo] of [[f.quantDias, 'Quant. dias'], [f.quantidade, 'Quantidade']]) {
            if (campo && campo.value.trim() && parseInt(campo.value, 10) !== parseInt(it.dias, 10)) falha(`${nomeCampo} ${it.dias}, tela mostra "${campo.value}"`);
        }
        if (f.numeroAto.value.replace(/\D/g, '') !== String(it.numeroAto)) falha(`Número ato ${it.numeroAto}, tela mostra "${f.numeroAto.value}"`);
        if (f.anoAto.value.trim() !== String(it.anoAto)) falha(`Ano ato ${it.anoAto}, tela mostra "${f.anoAto.value}"`);
        if (f.tipoAto && !textoNorm(f.tipoAto.value).includes(textoNorm(it.tipoAto))) falha(`Tipo ato ${it.tipoAto}, tela mostra "${f.tipoAto.value}"`);
        if (historicoNorm(f.historico.value) !== historicoNorm(it.historico)) falha('Histórico diferente do texto da conferência');
    }

    async function preencherFormulario(it) {
        let f = elementosForm();
        exigirCampos(f, ['dataIni', 'dataFim', 'numeroAto', 'anoAto', 'historico', 'incluir'], 'Formulário');
        if (f.lancamento) {
            let individual = Array.from(f.lancamento.options).find(o => /individual/i.test(o.text));
            if (individual && f.lancamento.value !== individual.value) { f.lancamento.value = individual.value; dispararEventos(f.lancamento); }
        }
        let descricao = await preencherAssentamento(it.codigo);
        await esperarRedeOciosa();

        f = elementosForm();
        preencherData(f.dataIni, it.dataIni);
        await esperar(TEMPO_ESPERA_CAMPO);
        preencherData(elementosForm().dataFim, it.dataFim);
        await esperar(TEMPO_ESPERA_CAMPO);
        await esperarRedeOciosa();

        f = elementosForm();
        for (let campo of [f.quantidade, f.quantDias]) {
            if (editavel(campo) && parseInt(campo.value, 10) !== parseInt(it.dias, 10)) preencherCampo(campo, String(it.dias));
        }
        preencherCampo(f.numeroAto, String(it.numeroAto));
        if (editavel(f.tipoAto) && !textoNorm(f.tipoAto.value).includes(textoNorm(it.tipoAto))) preencherCampo(f.tipoAto, it.tipoAto);
        preencherCampo(f.anoAto, String(it.anoAto));
        f = elementosForm();
        f.historico.focus();
        f.historico.value = it.historico;
        dispararEventos(f.historico);
        f.historico.blur();
        await esperar(TEMPO_ESPERA_CAMPO);
        await esperarRedeOciosa();
        conferirFormulario(it);
        return descricao;
    }

    function lerGridAssentamentos() {
        let fs = fieldsetPorLegenda('Últimos assentamentos lançados');
        return (lerTabela(fs, ['codigo', 'data inicial']) || []).map(l => ({
            codigo: l['codigo'], dataIni: l['data inicial'], dataFim: l['data final'] || '', quantidade: l['quantidade'] || ''
        }));
    }

    // Marca as linhas atuais do grid; linhas sem a marca = o grid recarregou (mesmo que com o mesmo conteúdo)
    function marcarGridVelho() {
        let fs = fieldsetPorLegenda('Últimos assentamentos lançados');
        if (fs) fs.querySelectorAll('tr').forEach(tr => { tr.__ecasVelho = true; });
    }

    function gridRecarregou() {
        let fs = fieldsetPorLegenda('Últimos assentamentos lançados');
        return !!fs && Array.from(fs.querySelectorAll('tr')).some(tr => !tr.__ecasVelho);
    }

    function noGrid(it, grid = lerGridAssentamentos()) {
        return grid.some(l => l.codigo === it.codigo && l.dataIni === it.dataIni && (!l.dataFim || l.dataFim === it.dataFim));
    }

    async function incluir(it) {
        let f = elementosForm();
        lerAlerta();
        f.incluir.click();
        let r = await esperarAte(() => {
            let a = espiarAlerta();
            if (a && REGEX_ALERTA_ERRO.test(a) && !REGEX_ALERTA_SUCESSO.test(a)) return { erro: a };
            if (noGrid(it)) return { ok: 'conferido no grid "Últimos assentamentos lançados"' };
            if (a && REGEX_ALERTA_SUCESSO.test(a)) return { ok: 'Sistema: ' + a };
            return null;
        }, 'a confirmação da inclusão', TEMPO_LIMITE_INCLUIR).catch(e => {
            relancarErroSistema(e);
            let a = espiarAlerta();
            throw new Error(a ? 'Sistema respondeu ao Incluir: ' + a : 'O e-cidade não confirmou a inclusão (sem mensagem e sem a linha no grid)');
        });
        let alerta = lerAlerta();
        if (ehErroDoSistema(alerta)) throw new ErroSistema(alerta);
        if (r.erro) throw new Error('Sistema recusou a inclusão: ' + r.erro);
        await esperarRedeOciosa();
        return r.ok + (alerta && !r.ok.includes(alerta) ? ` — Sistema: ${alerta}` : '');
    }

    // =========================================================================
    // ROBÔ: PROCESSA UM LANÇAMENTO (idempotente: confere o grid antes de incluir)
    // =========================================================================
    let ocupado = false;
    let gridDaMatricula = null; // matrícula cujo grid "Últimos assentamentos lançados" está na tela

    function lerItens() {
        return JSON.parse(localStorage.getItem(K_ITENS) || '[]');
    }

    function salvarItem(indice, mudancas) {
        let itens = lerItens();
        if (!itens[indice]) return;
        Object.assign(itens[indice], mudancas);
        localStorage.setItem(K_ITENS, JSON.stringify(itens));
    }

    async function processarItem(it, indice, itens) {
        let rotulo = `#${indice + 1} ${it.tipo === 'revogacao' ? 'Revogação' : 'Licença-prêmio'} ${it.nome}`;
        let problemas = validarItem(it);
        if (problemas.length) throw new Error(`${rotulo}: confira ${problemas.join(', ')} na conferência (📝)`);
        protegerAlertasDosFrames();
        if (!telaAssentamento()) throw new Error('Abra a tela Assentamentos Normais > Inclusão');

        // 1. Servidor
        marcarGridVelho();
        let matricula = await selecionarServidor(it, itens, indice);
        it.matriculaSistema = matricula;
        salvarItem(indice, { matriculaSistema: matricula });
        await esperarRedeOciosa();
        checarParada();

        // 2. Já lançado? Só confia no grid se ele recarregou para este servidor (ou já era dele)
        let recarregou = await esperarAte(() => gridRecarregou(), 'o grid do servidor recarregar', 6000)
            .then(() => true, e => { relancarErroSistema(e); return false; });
        if (recarregou) gridDaMatricula = matricula;
        if (gridDaMatricula === matricula) {
            if (noGrid(it)) {
                registrarLog('info', matricula, `${rotulo}: já está lançado (${it.codigo}, ${it.dataIni} a ${it.dataFim}) — não incluído de novo`);
                salvarItem(indice, { situacao: 'já lançado' });
                return;
            }
        } else {
            registrarLog('aviso', matricula, `${rotulo}: o grid "Últimos assentamentos lançados" não recarregou — não deu para conferir se já estava lançado`);
        }

        // 3. Preenche e confere
        mostrarAtual(`${rotulo}: preenchendo...`);
        let descricao = await preencherFormulario(it);
        checarParada();
        if (localStorage.getItem(K_AUTO) === 'nao') {
            throw new PausaRevisao(`${rotulo}: formulário preenchido e conferido. Revise, clique em Incluir e depois em Avançar ⏩.`);
        }

        // 4. Inclui
        let confirmacao = await incluir(it);
        salvarItem(indice, { situacao: 'lançado' });
        registrarLog('ok', matricula, `${rotulo}: incluído ${it.codigo} - ${descricao} (${it.dataIni} a ${it.dataFim}, ${it.dias} dia(s)) — ${confirmacao}`);
    }

    function registrarAviso(matricula, nome, aviso) {
        let lista = JSON.parse(localStorage.getItem(K_AVISOS) || '[]');
        lista.push({ h: new Date().toLocaleTimeString('pt-BR'), matricula, nome, aviso });
        localStorage.setItem(K_AVISOS, JSON.stringify(lista));
    }

    function pausar(it, indice, mensagem) {
        localStorage.setItem(K_STATUS, 'parado');
        registrarLog('erro', it.matriculaSistema || `#${indice + 1}`, mensagem + ' — robô PAUSADO. Corrija e use ▶ Iniciar (repete) ou Avançar ⏩ (pula).');
        setTimeout(() => alertaPainel('Robô de Assentamentos PAUSADO:\n\n' + mensagem), 50);
    }

    async function cicloRobo() {
        if (ocupado) return;
        if (localStorage.getItem(K_STATUS) !== 'rodando') return;
        if (!telaAssentamento()) return;

        let itens = lerItens();
        let index = parseInt(localStorage.getItem(K_INDEX) || '0', 10);
        if (index >= itens.length) {
            localStorage.setItem(K_STATUS, 'parado');
            mostrarAtual('Concluído! Todos os lançamentos foram processados.');
            registrarLog('ok', '-', 'Concluído: todos os lançamentos da portaria foram processados');
            atualizarPainel();
            return;
        }

        ocupado = true;
        let it = itens[index];
        try {
            if (it.tipo === 'pulado') {
                registrarLog('aviso', `#${index + 1}`, it.aviso || 'Item pulado');
                registrarAviso('', it.nome, it.aviso || 'Item pulado');
                salvarItem(index, { situacao: 'pulado' });
            } else {
                await processarItem(it, index, itens);
            }
            localStorage.removeItem(K_TENTATIVAS);
            localStorage.setItem(K_INDEX, String(index + 1));
        } catch (e) {
            if (e instanceof Repetir) {
                lerAlerta();
                fecharPopupPesquisa();
                let resumo = e.message.replace(/\s+/g, ' ').slice(0, 200);
                let motivo = e instanceof ErroSistema ? `Erro interno do e-cidade (${resumo}) — OK dado` : resumo;
                let anterior = JSON.parse(localStorage.getItem(K_TENTATIVAS) || '{}');
                let n = anterior.index === index ? anterior.n + 1 : 1;
                if (n < TENTATIVAS_REPETIR) {
                    localStorage.setItem(K_TENTATIVAS, JSON.stringify({ index, n }));
                    registrarLog('aviso', it.matriculaSistema || `#${index + 1}`, `${motivo}; tentando de novo (${n}/${TENTATIVAS_REPETIR})`);
                    await esperar(3000);
                    return;
                }
                localStorage.removeItem(K_TENTATIVAS);
                pausar(it, index, `${motivo} (falhou em ${TENTATIVAS_REPETIR} tentativas)`);
                return;
            }
            localStorage.removeItem(K_TENTATIVAS);
            if (e instanceof PausaRevisao) {
                localStorage.setItem(K_STATUS, 'parado');
                registrarLog('aviso', it.matriculaSistema || `#${index + 1}`, e.message);
            } else {
                console.error(e);
                pausar(it, index, e.message);
            }
        } finally {
            ocupado = false;
            atualizarPainel();
        }
    }

    // =========================================================================
    // LOG E ARQUIVOS
    // =========================================================================
    function registrarLog(nivel, matricula, mensagem) {
        let log = JSON.parse(localStorage.getItem(K_LOG) || '[]');
        log.push({ h: new Date().toLocaleTimeString('pt-BR'), nivel, matricula, mensagem });
        if (log.length > 2000) log = log.slice(-2000);
        localStorage.setItem(K_LOG, JSON.stringify(log));
        renderizarLog();
    }

    function renderizarLog() {
        let caixa = document.getElementById('ecas-log');
        if (!caixa) return;
        let log = JSON.parse(localStorage.getItem(K_LOG) || '[]');
        let cores = { erro: '#dc3545', aviso: '#c77c00', ok: '#28a745', info: '#555' };
        caixa.innerHTML = '';
        log.slice(-200).forEach(l => {
            let p = document.createElement('div');
            p.style.cssText = `color:${cores[l.nivel] || '#555'}; border-bottom:1px solid #eee; padding:2px 0;`;
            p.textContent = `${l.h} [${l.matricula}] ${l.mensagem}`;
            caixa.appendChild(p);
        });
        caixa.scrollTop = caixa.scrollHeight;
    }

    function baixarArquivo(nome, conteudo, tipo = 'text/csv') {
        let blob = new Blob(['﻿' + conteudo], { type: tipo + ';charset=utf-8' });
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = nome;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    function diagnosticoCampos() {
        let linhas = ['DOC;URL;TAG;TYPE;ID;NAME;VISIVEL;VALOR;TEXTO/OPCOES'];
        documentosAcessiveis().forEach((d, n) => {
            let url = (d.location ? d.location.pathname : '').split('/').pop();
            d.querySelectorAll('input, select, textarea, button, a, legend').forEach(el => {
                if (el.closest('#painel-ecas, #conferencia-ecas')) return;
                let texto = el.tagName === 'SELECT'
                    ? Array.from(el.options).map(o => o.text.trim()).slice(0, 30).join(' | ')
                    : (el.textContent || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
                linhas.push([n, url, el.tagName, el.type || '', el.id, el.name || '', visivel(el) ? 'S' : 'N', (el.value || '').slice(0, 40).replace(/[;\r\n]/g, ' '), texto.replace(/;/g, ',')].join(';'));
            });
        });
        baixarArquivo('diagnostico_campos_assentamentos.csv', linhas.join('\r\n'));
        let pop = acharPopupPesquisa();
        if (pop) setTimeout(() => baixarArquivo('diagnostico_pesquisa_servidores.html', pop.documentElement.outerHTML, 'text/html'), 600);
    }

    // =========================================================================
    // CONFERÊNCIA / EDIÇÃO DOS LANÇAMENTOS (tabela editável)
    // =========================================================================
    const COLUNAS_CONFERENCIA = [
        ['tipo', 'Tipo', 110], ['nome', 'Nome', 220], ['matriculaTexto', 'Mat. (portaria)', 70],
        ['matriculaSistema', 'Matrícula e-cidade', 85], ['codigo', 'Código', 50], ['dataIni', 'Data inicial', 85],
        ['dataFim', 'Data final', 85], ['dias', 'Dias', 40], ['aqIni', 'Aquisitivo início', 85], ['aqFim', 'Aquisitivo fim', 85],
        ['protocolo', 'Protocolo', 85], ['numeroAto', 'Nº ato', 55], ['anoAto', 'Ano ato', 50], ['historico', 'Histórico', 330]
    ];
    const CAMPOS_DO_HISTORICO = ['matriculaTexto', 'dias', 'dataIni', 'dataFim', 'aqIni', 'aqFim', 'protocolo'];

    function abrirConferencia() {
        let antigo = document.getElementById('conferencia-ecas');
        if (antigo) antigo.remove();
        let itens = lerItens();
        let fundo = document.createElement('div');
        fundo.id = 'conferencia-ecas';
        fundo.style.cssText = 'position:fixed; inset:10px; background:#fff; border:2px solid #0056b3; border-radius:8px; z-index:1000000; ' +
            'box-shadow:0 4px 12px rgba(0,0,0,.4); font:12px Arial, sans-serif; display:flex; flex-direction:column;';
        let topo = document.createElement('div');
        topo.style.cssText = 'padding:8px 12px; border-bottom:1px solid #ddd; display:flex; gap:10px; align-items:center;';
        let titulo = document.createElement('strong');
        let portaria = JSON.parse(localStorage.getItem(K_PORTARIA) || '{}');
        titulo.textContent = `Conferir lançamentos — Portaria nº ${portaria.numeroAto || '?'} de ${portaria.dataPortaria || '?'}`;
        titulo.style.cssText = 'flex:1; color:#0056b3; font-size:14px;';
        let dica = document.createElement('span');
        dica.textContent = 'Corrija o que o OCR leu errado. "Matrícula e-cidade" é opcional (força o cadastro). Tipo "pulado" = não lança.';
        dica.style.color = '#555';
        let fechar = document.createElement('button');
        fechar.textContent = '✔ Fechar';
        fechar.style.cssText = 'background:#28a745; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;';
        fechar.onclick = () => { fundo.remove(); atualizarPainel(); };
        topo.append(titulo, dica, fechar);

        let area = document.createElement('div');
        area.style.cssText = 'overflow:auto; flex:1; padding:6px;';
        let tabela = document.createElement('table');
        tabela.style.cssText = 'border-collapse:collapse; width:max-content;';
        let cab = tabela.insertRow();
        ['#'].concat(COLUNAS_CONFERENCIA.map(c => c[1]), ['Situação']).forEach(t => {
            let th = document.createElement('th');
            th.textContent = t;
            th.style.cssText = 'background:#e9eef5; border:1px solid #ccc; padding:3px; position:sticky; top:0;';
            cab.appendChild(th);
        });

        itens.forEach((it, i) => {
            let tr = tabela.insertRow();
            tr.style.background = it.tipo === 'pulado' ? '#fff3cd' : '';
            let num = tr.insertCell();
            num.textContent = i + 1;
            num.style.cssText = 'border:1px solid #ccc; padding:3px; text-align:center;';
            let situacao = document.createElement('td');
            const atualizarSituacao = () => {
                let atual = lerItens()[i];
                let p = validarItem(atual);
                situacao.textContent = atual.tipo === 'pulado' ? (atual.aviso || 'pulado') : (p.length ? 'Confira: ' + p.join(', ') : (atual.situacao || 'OK'));
                situacao.style.color = atual.tipo === 'pulado' ? '#c77c00' : (p.length ? '#dc3545' : '#28a745');
            };
            let campos = {};
            COLUNAS_CONFERENCIA.forEach(([chave, , largura]) => {
                let td = tr.insertCell();
                td.style.cssText = 'border:1px solid #ccc; padding:2px; vertical-align:top;';
                let el;
                if (chave === 'tipo') {
                    el = document.createElement('select');
                    [['licenca', 'Licença (35)'], ['revogacao', 'Revogação (353)'], ['pulado', 'Pulado']].forEach(([v, t]) => el.add(new Option(t, v)));
                } else if (chave === 'historico') {
                    el = document.createElement('textarea');
                    el.rows = 4;
                } else {
                    el = document.createElement('input');
                }
                el.value = it[chave] === undefined ? '' : String(it[chave]);
                el.style.cssText = `width:${largura}px; box-sizing:border-box; font:12px Arial;`;
                el.addEventListener('input', () => {
                    let mudancas = { [chave]: chave === 'dias' ? el.value.replace(/\D/g, '') : el.value.trim() };
                    if (chave === 'historico') { mudancas.historico = el.value; mudancas.historicoManual = true; }
                    if (chave === 'tipo') {
                        mudancas.codigo = el.value === 'licenca' ? CODIGO_LICENCA : el.value === 'revogacao' ? CODIGO_REVOGACAO : '';
                        campos.codigo.value = mudancas.codigo;
                        tr.style.background = el.value === 'pulado' ? '#fff3cd' : '';
                    }
                    salvarItem(i, mudancas);
                    let atual = lerItens()[i];
                    if (CAMPOS_DO_HISTORICO.concat('tipo').includes(chave) && atual.tipo === 'licenca' && !atual.historicoManual) {
                        salvarItem(i, { historico: gerarHistorico(atual) });
                        campos.historico.value = lerItens()[i].historico;
                    }
                    atualizarSituacao();
                });
                campos[chave] = el;
                td.appendChild(el);
            });
            situacao.style.cssText += 'border:1px solid #ccc; padding:3px; max-width:260px;';
            tr.appendChild(situacao);
            atualizarSituacao();
        });
        area.appendChild(tabela);

        let texto = document.createElement('details');
        texto.style.cssText = 'padding:6px 12px; border-top:1px solid #ddd;';
        let resumo = document.createElement('summary');
        resumo.textContent = 'Texto lido da foto (OCR)';
        let pre = document.createElement('pre');
        pre.textContent = localStorage.getItem(K_TEXTO) || '';
        pre.style.cssText = 'white-space:pre-wrap; max-height:180px; overflow:auto; background:#f8f9fa; padding:6px;';
        texto.append(resumo, pre);

        fundo.append(topo, area, texto);
        document.body.appendChild(fundo);
    }

    // =========================================================================
    // PAINEL FLUTUANTE
    // =========================================================================
    function gerenciarPainel() {
        let painelAtual = document.getElementById('painel-ecas');
        if (!telaAssentamento()) {
            if (painelAtual) painelAtual.remove();
            return;
        }
        if (painelAtual) {
            atualizarPainel();
            return;
        }

        const estiloBtn = 'flex:1; color:#fff; border:none; padding:5px; border-radius:4px; cursor:pointer; font-size:12px;';
        let div = document.createElement('div');
        div.id = 'painel-ecas';
        div.innerHTML = `
            <div style="position:fixed; bottom:20px; right:20px; background:#fff; border:2px solid #0056b3; padding:15px; border-radius:8px; z-index:999999; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-family: Arial, sans-serif; font-size: 14px; width: 340px; max-height: 95vh; overflow-y: auto; box-sizing: border-box;">
                <h3 style="margin: 0 0 10px 0; font-size: 16px; color: #0056b3;">Robô - Assentamentos (Portaria)</h3>

                <label style="display:block; margin-bottom: 5px; font-size: 12px;"><strong>1. Foto da portaria</strong></label>
                <input type="file" id="ecas-foto" accept="image/*" style="display:block; margin-bottom: 6px; width: 100%; font-size: 12px;">
                <button id="ecas-btn-ocr" style="${estiloBtn} width:100%; background:#0056b3; padding:8px; font-weight:bold; margin-bottom:6px;">⚙ 2. Ler foto (OCR)</button>
                <details style="margin-bottom:10px; font-size:12px;">
                    <summary style="cursor:pointer;">ou cole o texto da portaria</summary>
                    <textarea id="ecas-texto" rows="5" style="width:100%; box-sizing:border-box; margin-top:4px; font-size:11px;"></textarea>
                    <button id="ecas-btn-texto" style="${estiloBtn} width:100%; background:#0056b3; margin-top:4px;">Ler texto colado</button>
                </details>

                <button id="ecas-btn-conferir" style="${estiloBtn} width:100%; background:#6f42c1; padding:7px; margin-bottom:10px;">📝 3. Conferir / editar lançamentos</button>

                <label style="display:block; font-size: 12px; margin-bottom: 10px;"><input type="checkbox" id="ecas-auto"> Clicar em <strong>Incluir</strong> automaticamente</label>

                <div style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin-bottom: 10px; border: 1px solid #ddd;">
                    <p style="margin: 0 0 5px 0;">Status: <strong id="ecas-status-texto" style="color:#dc3545;">Parado</strong></p>
                    <p style="margin: 0 0 5px 0; font-size: 12px;" id="ecas-resumo"></p>
                    <p style="margin: 0 0 5px 0;">Progresso: <strong id="ecas-linha">0 / 0</strong> &nbsp;|&nbsp; Avisos: <strong id="ecas-qtd-avisos" style="color:#c77c00;">0</strong></p>
                    <p style="margin: 0; font-size: 12px; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" id="ecas-dados-atuais">Nenhum dado</p>
                    <p style="margin: 3px 0 0 0; font-size: 11px; color: #555; white-space: normal;" id="ecas-detalhe"></p>
                </div>

                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <button id="ecas-btn-play" style="flex:1; background: #28a745; color: #fff; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight:bold;">▶ Iniciar</button>
                    <button id="ecas-btn-pause" style="flex:1; background: #dc3545; color: #fff; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight:bold;">⏸ Parar</button>
                </div>

                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <button id="ecas-btn-prev" style="${estiloBtn} background: #6c757d;">⏪ Voltar</button>
                    <button id="ecas-btn-next" style="${estiloBtn} background: #17a2b8;">Avançar ⏩</button>
                </div>

                <div id="ecas-log" style="height: 110px; overflow-y: auto; font-size: 11px; border: 1px solid #ddd; border-radius: 4px; padding: 4px; margin-bottom: 8px; background:#fcfcfc;"></div>

                <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                    <button id="ecas-btn-avisos" style="${estiloBtn} background: #c77c00;">⬇ Avisos</button>
                    <button id="ecas-btn-ocr-txt" style="${estiloBtn} background: #343a40;">⬇ Texto lido</button>
                    <button id="ecas-btn-diag" style="${estiloBtn} background: #343a40;">🔎 Diagnóstico</button>
                </div>
            </div>
        `;
        document.body.appendChild(div);

        let chkAuto = document.getElementById('ecas-auto');
        chkAuto.checked = localStorage.getItem(K_AUTO) !== 'nao';
        chkAuto.addEventListener('change', () => localStorage.setItem(K_AUTO, chkAuto.checked ? 'sim' : 'nao'));

        document.getElementById('ecas-btn-ocr').addEventListener('click', lerFoto);
        document.getElementById('ecas-btn-texto').addEventListener('click', () => {
            let texto = document.getElementById('ecas-texto').value;
            if (!texto.trim()) { alertaPainel('Cole o texto da portaria.'); return; }
            carregarTexto(texto);
        });
        document.getElementById('ecas-btn-conferir').addEventListener('click', abrirConferencia);
        document.getElementById('ecas-btn-play').addEventListener('click', () => {
            let itens = lerItens();
            if (!itens.length) { alertaPainel('Leia a foto (ou cole o texto) da portaria primeiro.'); return; }
            let index = parseInt(localStorage.getItem(K_INDEX) || '0', 10);
            let problemas = itens.map((it, i) => ({ i, p: validarItem(it) })).filter(x => x.i >= index && x.p.length);
            if (problemas.length) {
                alertaPainel('Corrija antes de iniciar:\n\n' + problemas.map(x => `#${x.i + 1} ${itens[x.i].nome}: ${x.p.join(', ')}`).join('\n'));
                abrirConferencia();
                return;
            }
            localStorage.removeItem(K_ALERTA);
            localStorage.setItem(K_STATUS, 'rodando');
            atualizarPainel();
        });
        document.getElementById('ecas-btn-pause').addEventListener('click', () => { localStorage.setItem(K_STATUS, 'parado'); atualizarPainel(); });
        document.getElementById('ecas-btn-next').addEventListener('click', () => alterarIndice(1));
        document.getElementById('ecas-btn-prev').addEventListener('click', () => alterarIndice(-1));
        document.getElementById('ecas-btn-avisos').addEventListener('click', () => {
            let lista = JSON.parse(localStorage.getItem(K_AVISOS) || '[]');
            let log = JSON.parse(localStorage.getItem(K_LOG) || '[]').filter(l => l.nivel === 'erro');
            let linhas = ['HORA;MATRICULA;NOME;AVISO']
                .concat(lista.map(x => [x.h, x.matricula, x.nome, x.aviso.replace(/[;\r\n]/g, ' ')].join(';')))
                .concat(log.map(l => [l.h, l.matricula, '', l.mensagem.replace(/[;\r\n]/g, ' ')].join(';')));
            baixarArquivo('assentamentos_avisos.csv', linhas.join('\r\n'));
        });
        document.getElementById('ecas-btn-ocr-txt').addEventListener('click', () => baixarArquivo('portaria_texto_lido.txt', localStorage.getItem(K_TEXTO) || '', 'text/plain'));
        document.getElementById('ecas-btn-diag').addEventListener('click', diagnosticoCampos);

        renderizarLog();
        atualizarPainel();
    }

    function alterarIndice(delta) {
        let itens = lerItens();
        let index = parseInt(localStorage.getItem(K_INDEX) || '0', 10) + delta;
        if (index > itens.length) index = itens.length;
        if (index < 0) index = 0;
        localStorage.setItem(K_INDEX, String(index));
        localStorage.removeItem(K_TENTATIVAS);
        atualizarPainel();
    }

    function mostrarAtual(texto) {
        let el = document.getElementById('ecas-dados-atuais');
        if (el) el.textContent = texto;
    }

    function atualizarPainel() {
        let statusElement = document.getElementById('ecas-status-texto');
        if (!statusElement) return;
        let portaria = JSON.parse(localStorage.getItem(K_PORTARIA) || 'null');
        let itens = lerItens();
        let index = parseInt(localStorage.getItem(K_INDEX) || '0', 10);
        document.getElementById('ecas-resumo').textContent = portaria
            ? `Portaria nº ${portaria.numeroAto || '?'} de ${portaria.dataPortaria || '?'} — ${itens.length} lançamento(s)`
            : 'Portaria ainda não lida';
        document.getElementById('ecas-qtd-avisos').textContent = JSON.parse(localStorage.getItem(K_AVISOS) || '[]').length;

        if (localStorage.getItem(K_STATUS) === 'rodando') {
            statusElement.textContent = 'RODANDO 🟢';
            statusElement.style.color = '#28a745';
        } else {
            statusElement.textContent = 'PARADO 🔴';
            statusElement.style.color = '#dc3545';
        }
        let linha = document.getElementById('ecas-linha');
        let detalhe = document.getElementById('ecas-detalhe');
        if (!itens.length) return;
        linha.textContent = `${Math.min(index + 1, itens.length)} de ${itens.length}`;
        if (index < itens.length) {
            let it = itens[index];
            if (!ocupado) mostrarAtual(`Em foco: #${index + 1} ${it.nome || '(sem nome)'}${it.matriculaSistema ? ' - ' + it.matriculaSistema : ''}`);
            detalhe.textContent = it.tipo === 'pulado'
                ? (it.aviso || 'pulado')
                : `${it.codigo} ${it.tipo === 'revogacao' ? 'Revogação' : 'Licença-prêmio'}: ${it.dataIni} a ${it.dataFim} (${it.dias} dia(s)) — ato ${it.numeroAto}/${it.anoAto}`;
        } else {
            detalhe.textContent = 'Fim da lista.';
        }
    }

    // Loop de controle
    setInterval(() => {
        dispensarDialogoErro();
        gerenciarPainel();
        cicloRobo();
    }, TEMPO_LOOP);
})();

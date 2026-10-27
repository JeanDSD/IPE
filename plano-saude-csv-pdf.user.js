// ==UserScript==
// @name         Plano de Saúde - Cruzamento CSV x PDF IPE e Lançamento Automático
// @namespace    http://tampermonkey.net/
// @version      6.2
// @description  Cruza o CSV da rubrica (R963) com o PDF de contribuições do IPE Saúde, valida titular + dependentes e lança no Plano de Saúde do e-cidade.
// @match        https://ecidade.saoborja.rs.gov.br/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================================
    // CONFIGURAÇÕES DE TEMPO
    // =========================================================================
    const TEMPO_LOOP = 1000;
    const TEMPO_ESPERA_MATRICULA = 1500;   // estabilização após carregar matrícula/competência
    const TEMPO_ESPERA_CAMPO = 300;        // após preencher um campo, antes de conferir
    const TEMPO_ESPERA_POS_SALVAR = 1000;
    const TEMPO_LIMITE = 15000;            // limite das esperas dinâmicas (aba, popup, carregamento)
    const TEMPO_LIMITE_SALVAR = 20000;     // limite para o dependente aparecer no grid após salvar

    // =========================================================================
    // IDS / SELETORES DA TELA "PLANO DE SAÚDE" (pes1_plano_saude_servidor001.php)
    // =========================================================================
    const ID_COMPETENCIA = 'competencia';
    const ID_CODIGO = 'codigoServidor';
    const ID_VALOR = 'valorServidor';
    const ID_PERCENTUAL = 'percentualEmpregadorSe';
    const ID_SALVAR = 'salvarServidorOperadoraSaude';

    // Aba "Dependentes": o robô acha os campos pelo rótulo (Dependente:, Tipo:, Valor:, Percentual
    // Patronal Empregador:) dentro do quadro "Dependente". Só preencha se precisar forçar um ID
    // descoberto pelo "🔎 Diagnóstico" (ex: tipo: '#tipoDependente').
    const SELETORES_DEPENDENTE = {
        link: null,        // link azul "Dependente:" que abre o popup de pesquisa
        codigo: null,      // input do código do dependente
        nome: null,        // input (somente leitura) do nome do dependente
        tipo: null,        // <select> Tipo
        valor: null,       // input Valor
        percentual: null,  // input Percentual Patronal Empregador
        salvar: null,      // botão Salvar da aba Dependentes
        novo: null         // botão Novo da aba Dependentes
    };

    // =========================================================================
    // REGRAS DE NEGÓCIO
    // =========================================================================
    const PERCENTUAL_TITULAR = '67,73';
    const PERCENTUAL_FILHO = '0';           // filho(a) ou enteado(a)
    const PERCENTUAL_CONJUGE = '67,73';     // cônjuge: mesmo percentual do titular
    const IDADE_MAIORIDADE = 18;
    const TIPO_FILHO = 'filho ou enteado';
    const TIPO_CONJUGE = 'cônjuge';
    // Únicas opções aceitas no <select> Tipo (comparadas sem acento e em minúsculas)
    const OPCOES_TIPO = {
        [TIPO_FILHO]: /^filho(\(a\))? ou enteado(\(a\))?$/,
        [TIPO_CONJUGE]: /^conjuge$/
    };

    // Chaves do localStorage (prefixo próprio para não conflitar com o robô antigo)
    const K_STATUS = 'ecps_status';
    const K_DADOS = 'ecps_lista_dados';
    const K_INDEX = 'ecps_index';
    const K_ETAPA = 'ecps_etapa';
    const K_LOG = 'ecps_log';
    const K_ERROS_CRUZAMENTO = 'ecps_erros_cruzamento';
    const K_COMPETENCIA = 'ecps_competencia';
    const K_AUTO_SALVAR = 'ecps_auto_salvar';
    const K_PULAR_LANCADOS = 'ecps_pular_lancados';
    const K_RESUMO = 'ecps_resumo';
    const K_ALERTA = 'ecps_alerta';

    // =========================================================================
    // <<NUCLEO>> PROCESSAMENTO DOS ARQUIVOS (funções puras, sem DOM)
    // =========================================================================
    const REGEX_LINHA_PDF = /^(.+?)\s+(Titular Ativo|Titular Inativo|Titular|Pensionista|Dependente)\s+(?:(\d{3}\.\d{3}\.\d{3}-\d{2})\s+)?(\d{6,})\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{1,3})\s+(.+?)\s+R\$\s*([\d.]+,\d{2})$/i;
    const PARTICULAS = ['DE', 'DA', 'DO', 'DOS', 'DAS', 'E', 'D'];

    function parseCentavos(valorString) {
        if (valorString === null || valorString === undefined) return 0;
        let limpo = valorString.toString().replace(/[R$\s%]/g, '');
        if (limpo.includes(',')) {
            limpo = limpo.replace(/\./g, '').replace(',', '.');       // 1.173,07 (padrão BR)
        } else if (/^\d{1,3}(\.\d{3})+$/.test(limpo)) {
            limpo = limpo.replace(/\./g, '');                         // 1.173 (só milhar)
        }                                                              // senão 67.73: ponto decimal (grid do e-cidade)
        let num = parseFloat(limpo);
        return isNaN(num) ? 0 : Math.round(num * 100);
    }

    function formatCentavos(centavos) {
        // sem toFixed: o e-cidade sobrescreve Number.prototype.toFixed e ele passa a devolver número
        let total = Math.round(Math.abs(centavos));
        let resto = total % 100;
        return (centavos < 0 ? '-' : '') + String((total - resto) / 100) + ',' + (resto < 10 ? '0' : '') + String(resto);
    }

    function normalizarNome(nome) {
        return (nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Compara nome completo (CSV) com nome do PDF, que pode vir abreviado:
    // "ACHILLES LEONARDO FERREIRA LANG" x "ACHILLES LEONARDO F LANG"
    function nomesCompativeis(nomeCsv, nomePdf) {
        let a = normalizarNome(nomeCsv).split(' ');
        let b = normalizarNome(nomePdf).split(' ');
        if (!a[0] || a[0] !== b[0]) return false;

        function casa(i, j) {
            if (i === a.length && j === b.length) return true;
            if (i < a.length && PARTICULAS.includes(a[i]) && casa(i + 1, j)) return true;
            if (j < b.length && PARTICULAS.includes(b[j]) && casa(i, j + 1)) return true;
            if (i === a.length || j === b.length) return false;
            if (a[i] === b[j]) return casa(i + 1, j + 1);
            if (b[j].length === 1 && a[i].startsWith(b[j])) return casa(i + 1, j + 1);
            // último termo do PDF truncado (nome cortado por tamanho)
            if (j === b.length - 1 && i === a.length - 1 && b[j].length >= 3 && a[i].startsWith(b[j])) return true;
            return false;
        }
        return casa(0, 0);
    }

    function distanciaEdicao(a, b) {
        // sem Array.from(..., fn): a Prototype.js do e-cidade substitui Array.from e ignora o mapeamento
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

    // Casamento aproximado (sobrenome de casada, nome cortado, erro de digitação):
    // mesmo primeiro nome e pelo menos 2 sobrenomes em comum
    function nomesSemelhantes(nomeCsv, nomePdf) {
        let a = normalizarNome(nomeCsv).split(' ').filter(t => !PARTICULAS.includes(t));
        let b = normalizarNome(nomePdf).split(' ').filter(t => !PARTICULAS.includes(t));
        if (!a[0] || a[0] !== b[0]) return false;
        let comuns = a.slice(1).filter(t => t.length > 1 && b.slice(1).some(u => u.length > 1 && termosParecidos(t, u))).length;
        return comuns >= 2;
    }

    // Recebe as linhas de texto (uma por linha visual do PDF) e devolve os segurados
    function parsearLinhasPdf(linhas) {
        let registros = [];
        for (let linha of linhas) {
            let m = linha.replace(/\s+/g, ' ').trim().match(REGEX_LINHA_PDF);
            if (!m) continue;
            registros.push({
                nome: m[1].trim(),
                tipo: m[2].replace(/\s+/g, ' '),
                cpf: m[3] || '',
                matriculaIpe: m[4],
                nascimento: m[5],
                idade: parseInt(m[6], 10),
                faixa: m[7].trim(),
                contribuicao: parseCentavos(m[8])
            });
        }
        return registros;
    }

    // Dependentes pertencem ao último titular (Titular/Ativo/Inativo/Pensionista) acima deles
    function agruparTitulares(registros) {
        let titulares = [];
        let orfaos = [];
        let atual = null;
        for (let r of registros) {
            if (/^dependente$/i.test(r.tipo)) {
                if (atual) atual.dependentes.push(r);
                else orfaos.push(r);
            } else {
                atual = Object.assign({}, r, { dependentes: [] });
                titulares.push(atual);
            }
        }
        return { titulares, orfaos };
    }

    function parsearCsv(texto) {
        let linhas = texto.split(/\r?\n/);
        let cab = -1;
        for (let i = 0; i < linhas.length; i++) {
            if (/^\s*MATR[IÍ]CULA\s*;/i.test(linhas[i])) { cab = i; break; }
        }
        let colunas = cab >= 0 ? linhas[cab].split(';').map(c => normalizarNome(c)) : [];
        let iMat = Math.max(0, colunas.indexOf('MATRICULA'));
        let iNome = colunas.indexOf('NOME');
        let iValor = colunas.indexOf('VALOR');
        if (iNome < 0) iNome = 1;
        if (iValor < 0) iValor = 3;

        let servidores = [];
        for (let i = cab + 1; i < linhas.length; i++) {
            let c = linhas[i].split(';');
            let mat = (c[iMat] || '').trim();
            if (!/^\d+$/.test(mat)) continue;
            servidores.push({
                matricula: mat,
                nome: (c[iNome] || '').trim(),
                valorCsv: parseCentavos(c[iValor])
            });
        }
        return servidores;
    }

    function percentualDependentePorTipo(tipo) {
        return tipo === TIPO_CONJUGE ? PERCENTUAL_CONJUGE : PERCENTUAL_FILHO;
    }

    function tipoDependentePorIdade(idade) {
        return idade < IDADE_MAIORIDADE ? TIPO_FILHO : TIPO_CONJUGE;
    }

    function somaTitular(t) {
        return t.contribuicao + t.dependentes.reduce((s, d) => s + d.contribuicao, 0);
    }

    // Cruza CSV x PDF. Retorna lista validada (pronta para o robô) e lista de erros.
    function cruzarDados(servidores, titulares) {
        let lista = [];
        let erros = [];
        let usoTitular = new Map();

        let candidatosPorServidor = servidores.map(s => {
            let porMatricula = titulares.filter(t => t.matriculaIpe === s.matricula);
            let cands = porMatricula.length ? porMatricula : titulares.filter(t => nomesCompativeis(s.nome, t.nome));
            // Vários homônimos: fica só com quem bate o valor
            if (cands.length > 1) {
                let batem = cands.filter(t => somaTitular(t) === s.valorCsv);
                if (batem.length >= 1) cands = batem;
            }
            if (cands.length === 1) usoTitular.set(cands[0], (usoTitular.get(cands[0]) || 0) + 1);
            return cands;
        });

        // 2ª passada: quem não casou pelo nome exato só é aceito se o nome for semelhante
        // E a soma bater exatamente E houver um único candidato ainda não utilizado
        let aproximados = new Set();
        servidores.forEach((s, i) => {
            if (candidatosPorServidor[i].length) return;
            let cands = titulares.filter(t => !usoTitular.has(t) && somaTitular(t) === s.valorCsv && nomesSemelhantes(s.nome, t.nome));
            if (cands.length === 1) {
                candidatosPorServidor[i] = cands;
                usoTitular.set(cands[0], (usoTitular.get(cands[0]) || 0) + 1);
                aproximados.add(i);
            }
        });

        servidores.forEach((s, i) => {
            let cands = candidatosPorServidor[i];
            let base = { matricula: s.matricula, nome: s.nome, valorCsv: formatCentavos(s.valorCsv) };
            if (cands.length === 0) {
                erros.push(Object.assign(base, { motivo: 'Servidor não encontrado no PDF' }));
                return;
            }
            if (cands.length > 1) {
                erros.push(Object.assign(base, { motivo: `Nome ambíguo no PDF (${cands.length} titulares possíveis)` }));
                return;
            }
            let t = cands[0];
            if (usoTitular.get(t) > 1) {
                erros.push(Object.assign(base, { motivo: `Titular do PDF "${t.nome}" casou com mais de uma matrícula do CSV` }));
                return;
            }
            let soma = somaTitular(t);
            if (soma !== s.valorCsv) {
                erros.push(Object.assign(base, {
                    motivo: `Soma PDF ${formatCentavos(soma)} ≠ CSV ${formatCentavos(s.valorCsv)} (titular ${formatCentavos(t.contribuicao)} + ${t.dependentes.length} dep.)`
                }));
                return;
            }
            lista.push({
                matricula: s.matricula,
                nome: s.nome,
                nomePdf: t.nome,
                tipoPdf: t.tipo,
                casamentoAproximado: aproximados.has(i),
                valorCsv: formatCentavos(s.valorCsv),
                titular: { valor: formatCentavos(t.contribuicao), percentual: PERCENTUAL_TITULAR },
                dependentes: t.dependentes.map(d => ({
                    nome: d.nome,
                    idade: d.idade,
                    nascimento: d.nascimento,
                    tipo: tipoDependentePorIdade(d.idade),
                    percentual: percentualDependentePorTipo(tipoDependentePorIdade(d.idade)),
                    valor: formatCentavos(d.contribuicao)
                }))
            });
        });
        return { lista, erros };
    }

    function gerarCsvProcessado(lista) {
        let out = ['MATRICULA;NOME;TIPO;PESSOA;IDADE;TIPO_SISTEMA;PERCENTUAL;VALOR;TOTAL_CSV;CASAMENTO'];
        for (let r of lista) {
            let casamento = r.casamentoAproximado ? 'APROXIMADO' : 'EXATO';
            out.push([r.matricula, r.nome, 'TITULAR', r.nomePdf, '', r.tipoPdf, r.titular.percentual, r.titular.valor, r.valorCsv, casamento].join(';'));
            for (let d of r.dependentes) {
                out.push([r.matricula, r.nome, 'DEPENDENTE', d.nome, d.idade, d.tipo, d.percentual, d.valor, r.valorCsv, casamento].join(';'));
            }
        }
        return out.join('\r\n');
    }
    // <<FIM NUCLEO>>

    // =========================================================================
    // LEITURA DOS ARQUIVOS (FileReader + pdf.js)
    // =========================================================================
    function lerArquivoBuffer(arquivo) {
        return new Promise((resolve, reject) => {
            let fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => reject(fr.error);
            fr.readAsArrayBuffer(arquivo);
        });
    }

    async function lerCsvTexto(arquivo) {
        let buffer = await lerArquivoBuffer(arquivo);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch (e) {
            return new TextDecoder('windows-1252').decode(buffer); // CSV do e-cidade vem em ISO-8859-1
        }
    }

    function obterPdfJs() {
        let lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'] ||
            (typeof pdfjsLib !== 'undefined' ? pdfjsLib : null); // eslint-disable-line no-undef
        if (lib && lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
            lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        return lib;
    }

    // Monta as linhas visuais do PDF agrupando os textos pela coordenada Y
    // O e-cidade usa a Prototype.js, que adiciona métodos enumeráveis em Array.prototype
    // (each, pluck, clear...). O pdf.js recusa rodar assim, então durante a leitura do PDF
    // esses métodos ficam não-enumeráveis (continuam funcionando) e depois são restaurados.
    async function extrairLinhasPdf(pdfjs, buffer, aoProgredir) {
        let chaves = [];
        for (let k in Array.prototype) chaves.push(k); // eslint-disable-line guard-for-in
        chaves.forEach(k => Object.defineProperty(Array.prototype, k, { enumerable: false }));
        try {
            return await extrairLinhasPdfInterno(pdfjs, buffer, aoProgredir);
        } finally {
            chaves.forEach(k => Object.defineProperty(Array.prototype, k, { enumerable: true }));
        }
    }

    async function extrairLinhasPdfInterno(pdfjs, buffer, aoProgredir) {
        let doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        let linhas = [];
        for (let p = 1; p <= doc.numPages; p++) {
            let pagina = await doc.getPage(p);
            let conteudo = await pagina.getTextContent();
            let grupos = [];
            for (let item of conteudo.items) {
                if (!item.str || !item.str.trim()) continue;
                let x = item.transform[4];
                let y = item.transform[5];
                let g = grupos.find(gr => Math.abs(gr.y - y) <= 2);
                if (!g) { g = { y, itens: [] }; grupos.push(g); }
                g.itens.push({ x, s: item.str.trim() });
            }
            grupos.sort((a, b) => b.y - a.y);
            for (let g of grupos) {
                g.itens.sort((a, b) => a.x - b.x);
                linhas.push(g.itens.map(i => i.s).join(' '));
            }
            if (aoProgredir) aoProgredir(p, doc.numPages);
        }
        return linhas;
    }

    async function processarArquivos() {
        let arqCsv = document.getElementById('ecps-csv').files[0];
        let arqPdf = document.getElementById('ecps-pdf').files[0];
        if (!arqCsv || !arqPdf) {
            alertaPainel('Selecione o CSV e o PDF antes de processar.');
            return;
        }
        let pdfjs = obterPdfJs();
        if (!pdfjs) {
            alertaPainel('Biblioteca pdf.js não carregou. Verifique os @require do script.');
            return;
        }
        let info = document.getElementById('ecps-dados-atuais');
        try {
            info.textContent = 'Lendo CSV...';
            let servidores = parsearCsv(await lerCsvTexto(arqCsv));

            let linhas = await extrairLinhasPdf(pdfjs, await lerArquivoBuffer(arqPdf),
                (p, total) => { info.textContent = `Lendo PDF: página ${p} de ${total}`; });
            let registros = parsearLinhasPdf(linhas);
            let { titulares, orfaos } = agruparTitulares(registros);

            let { lista, erros } = cruzarDados(servidores, titulares);
            orfaos.forEach(o => erros.push({ matricula: '-', nome: o.nome, valorCsv: '', motivo: 'Dependente sem titular acima no PDF' }));

            localStorage.setItem(K_DADOS, JSON.stringify(lista));
            localStorage.setItem(K_ERROS_CRUZAMENTO, JSON.stringify(erros));
            localStorage.setItem(K_INDEX, '0');
            localStorage.setItem(K_ETAPA, '');
            localStorage.setItem(K_STATUS, 'parado');
            localStorage.setItem(K_LOG, '[]');

            registrarLog('info', '-', `CSV: ${servidores.length} matrículas | PDF: ${titulares.length} titulares, ${registros.length - titulares.length} dependentes`);
            registrarLog('info', '-', `Validados: ${lista.length} | Com erro no cruzamento: ${erros.length}`);
            erros.forEach(e => registrarLog('erro', e.matricula, `${e.nome}: ${e.motivo}`));
            lista.filter(r => r.casamentoAproximado)
                .forEach(r => registrarLog('aviso', r.matricula, `Casado por nome aproximado + valor: "${r.nome}" ≈ PDF "${r.nomePdf}"`));
            localStorage.setItem(K_RESUMO, `Cruzamento: ${lista.length} validados, ${erros.length} com erro`);
        } catch (e) {
            console.error(e);
            alertaPainel('Erro ao processar arquivos: ' + e.message);
        }
        atualizarPainel();
    }

    // =========================================================================
    // FUNÇÕES AUXILIARES DE DOM
    // =========================================================================
    const esperar = ms => new Promise(r => setTimeout(r, ms));
    const REGEX_ALERTA_ERRO = /erro|inv[aá]lid|obrigat|n[aã]o foi|n[aã]o pode|falha|j[aá] existe|j[aá] cadastrad/i;

    // Pausa "boa": o robô preencheu e espera o usuário revisar e salvar (modo sem Salvar automático)
    class PausaRevisao extends Error {}

    function checarParada() {
        if (localStorage.getItem(K_STATUS) !== 'rodando') throw new Error('Interrompido pelo usuário (⏸ Parar)');
    }

    // Espera dinâmica: reavalia a condição a cada mudança no DOM (MutationObserver) e a cada 200 ms
    // (o polling cobre valores de inputs e iframes novos, que não geram mutação aqui).
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

    function textoNorm(texto) {
        return (texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function dispararEventos(elemento) {
        elemento.dispatchEvent(new Event('input', { bubbles: true }));
        elemento.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function dispararEnter(elemento) {
        for (let tipo of ['keydown', 'keypress', 'keyup']) {
            elemento.dispatchEvent(new KeyboardEvent(tipo, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
    }

    function preencherCampo(elemento, valor) {
        elemento.focus();
        elemento.value = '';
        dispararEventos(elemento);
        elemento.value = valor;
        dispararEventos(elemento);
        elemento.dispatchEvent(new Event('blur', { bubbles: true }));
        elemento.blur();
    }

    function visivel(el) {
        return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    }

    // Documento do Plano de Saúde + iframes internos (popups) + janela do topo e seus iframes
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

    function nomesBatem(a, b) {
        let na = normalizarNome(a);
        let nb = normalizarNome(b);
        if (!na || !nb) return false;
        if (na === nb) return true;
        if (Math.min(na.length, nb.length) >= 20 && (na.startsWith(nb) || nb.startsWith(na))) return true; // nome cortado no CSV
        return nomesCompativeis(a, b) || nomesCompativeis(b, a) || nomesSemelhantes(a, b);
    }

    // Prefere casamento estrito (igual/abreviado); só usa o aproximado se o estrito não achar nada
    function filtrarPorNome(lista, nomeDe, nome) {
        let estritos = lista.filter(l => {
            let n = nomeDe(l);
            return normalizarNome(n) === normalizarNome(nome) || nomesCompativeis(n, nome) || nomesCompativeis(nome, n);
        });
        return estritos.length ? estritos : lista.filter(l => nomesBatem(nomeDe(l), nome));
    }

    // =========================================================================
    // CAPTURA DE ALERT (todas as janelas acessíveis, inclusive popups)
    // =========================================================================
    // Guardado no localStorage para que o alerta de qualquer frame chegue ao robô
    function instalarCapturaAlerta(win) {
        try {
            if (!win || win.__ecpsAlertaOriginal) return;
            let original = win.alert;
            win.alert = function(msg) {
                if (localStorage.getItem(K_STATUS) === 'rodando') {
                    localStorage.setItem(K_ALERTA, String(msg));
                    console.log('[Robô Plano de Saúde] alert capturado:', msg);
                    return;
                }
                return original.call(win, msg);
            };
            win.__ecpsAlertaOriginal = original;
        } catch (e) { /* janela inacessível */ }
    }
    instalarCapturaAlerta(window);
    const alertOriginal = window.__ecpsAlertaOriginal || window.alert;

    function protegerAlertasDosFrames() {
        documentosAcessiveis().forEach(d => instalarCapturaAlerta(d.defaultView));
    }

    function espiarAlerta() {
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
        let alvo = textoNorm(rotulo).replace(/:$/, '');
        let rotulos = Array.from(escopo.querySelectorAll('td, th, label'))
            .filter(el => textoNorm(el.textContent).replace(/:$/, '') === alvo && !el.querySelector('input, select, textarea'));
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
            .find(b => visivel(b) && textoNorm(b.value || b.textContent) === alvo && !b.closest('#painel-ecps')) || null;
    }

    // Primeiro botão visível com o texto que fica dentro ou logo depois do fieldset
    function botaoApos(fs, texto) {
        if (!fs) return null;
        let alvo = textoNorm(texto);
        return Array.from(fs.ownerDocument.querySelectorAll('input[type=button], input[type=submit], button'))
            .filter(b => visivel(b) && textoNorm(b.value || b.textContent) === alvo && !b.closest('#painel-ecps'))
            .find(b => fs.contains(b) || (fs.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) || null;
    }

    // Lê uma tabela: acha a linha de cabeçalho (com as colunas pedidas) e devolve as linhas seguintes
    // como objetos { 'nome': ..., 'tipo': ..., _tr, _cel }
    function lerTabela(escopo, colunasObrigatorias) {
        if (!escopo) return null;
        let trs = Array.from(escopo.querySelectorAll('tr'));
        let iCab = trs.findIndex(tr => {
            let textos = Array.from(tr.cells).map(c => textoNorm(c.textContent));
            return colunasObrigatorias.every(col => textos.includes(col));
        });
        if (iCab < 0) return null;
        let cab = Array.from(trs[iCab].cells).map(c => textoNorm(c.textContent));
        let linhas = [];
        for (let tr of trs.slice(iCab + 1)) {
            if (tr.cells.length < cab.length) continue;
            let obj = { _tr: tr, _cel: {} };
            let algumTexto = false;
            cab.forEach((col, i) => {
                let celula = tr.cells[i];
                obj[col] = (celula.textContent || '').replace(/\s+/g, ' ').trim();
                obj._cel[col] = celula;
                if (obj[col]) algumTexto = true;
            });
            if (algumTexto) linhas.push(obj);
        }
        return linhas;
    }

    function localizarAba(nome) {
        let alvo = textoNorm(nome);
        let candidatos = Array.from(document.querySelectorAll('a, li, td, th, div, span, button, input[type=button]'))
            .filter(el => visivel(el) && !el.closest('fieldset') && !el.closest('#painel-ecps') &&
                textoNorm(el.tagName === 'INPUT' ? el.value : el.textContent) === alvo);
        // fica com o elemento mais interno (o próprio texto da aba)
        return candidatos.find(el => !candidatos.some(o => o !== el && el.contains(o))) || null;
    }

    async function irParaAba(nomeAba, legendaFormulario) {
        if (fieldsetPorLegenda(legendaFormulario)) return;
        let aba = localizarAba(nomeAba);
        if (!aba) throw new Error(`Aba "${nomeAba}" não encontrada na tela`);
        aba.click();
        await esperarAte(() => fieldsetPorLegenda(legendaFormulario), `abrir a aba "${nomeAba}"`);
        await esperar(TEMPO_ESPERA_CAMPO);
    }

    function porSeletor(chave) {
        let s = SELETORES_DEPENDENTE[chave];
        return s ? document.querySelector(s) : null;
    }

    function elementosTitular() {
        let fs = fieldsetPorLegenda('Plano de Saúde do Servidor');
        let servidor = camposAposRotulo(fs, 'Servidor');
        let competencia = document.getElementById(ID_COMPETENCIA);
        if (!competencia || competencia.tagName !== 'SELECT') {
            competencia = camposAposRotulo(fs, 'Competência').find(c => c.tagName === 'SELECT') || competencia;
        }
        return {
            fieldset: fs,
            codigo: document.getElementById(ID_CODIGO) || servidor[0] || null,
            nome: servidor[1] || null,
            competencia: competencia || null,
            valor: document.getElementById(ID_VALOR) || camposAposRotulo(fs, 'Valor')[0] || null,
            percentual: document.getElementById(ID_PERCENTUAL) || camposAposRotulo(fs, 'Percentual Patronal Empregador')[0] || null,
            salvar: document.getElementById(ID_SALVAR) || botaoApos(fs, 'Salvar')
        };
    }

    function elementosDependente() {
        let fs = fieldsetPorLegenda('Dependente');
        let dependente = camposAposRotulo(fs, 'Dependente');
        let link = fs ? Array.from(fs.querySelectorAll('a')).find(a => textoNorm(a.textContent).replace(/:$/, '') === 'dependente') : null;
        return {
            fieldset: fs,
            link: porSeletor('link') || link || null,
            codigo: porSeletor('codigo') || dependente[0] || null,
            nome: porSeletor('nome') || dependente[1] || null,
            tipo: porSeletor('tipo') || camposAposRotulo(fs, 'Tipo').find(c => c.tagName === 'SELECT') || null,
            valor: porSeletor('valor') || camposAposRotulo(fs, 'Valor')[0] || null,
            percentual: porSeletor('percentual') || camposAposRotulo(fs, 'Percentual Patronal Empregador')[0] || null,
            salvar: porSeletor('salvar') || botaoApos(fs, 'Salvar'),
            novo: porSeletor('novo') || botaoApos(fs, 'Novo')
        };
    }

    function exigirCampos(obj, chaves, contexto) {
        let faltando = chaves.filter(k => !obj[k]);
        if (faltando.length) {
            throw new Error(`${contexto}: não encontrei na tela: ${faltando.join(', ')} (envie o 🔎 Diagnóstico)`);
        }
    }

    // =========================================================================
    // CONFERÊNCIAS
    // =========================================================================
    function conferirCampo(campo, esperado, descricao) {
        if (!campo.value.trim() || parseCentavos(campo.value) !== parseCentavos(esperado)) {
            throw new Error(`Conferência falhou: ${descricao} deveria ser "${esperado}", mas a tela mostra "${campo.value}"`);
        }
    }

    async function preencherEConferir(campo, valor, descricao) {
        preencherCampo(campo, valor);
        await esperar(TEMPO_ESPERA_CAMPO);
        conferirCampo(campo, valor, descricao);
    }

    function tipoConfere(texto, tipo) {
        return OPCOES_TIPO[tipo].test(textoNorm(texto));
    }

    // Seleciona SOMENTE "Filho(a) ou enteado(a)" ou "Cônjuge"; qualquer outra situação pausa
    function selecionarTipo(select, tipo, descricao) {
        let opcoes = Array.from(select.options).filter(o => tipoConfere(o.text, tipo));
        if (opcoes.length !== 1) {
            throw new Error(`${descricao}: opção "${tipo}" não encontrada (ou repetida) no campo Tipo. Opções: ${Array.from(select.options).map(o => o.text.trim()).join(' | ')}`);
        }
        select.value = opcoes[0].value;
        dispararEventos(select);
        conferirTipo(select, tipo, descricao);
    }

    function conferirTipo(select, tipo, descricao) {
        let atual = select.selectedIndex >= 0 ? select.options[select.selectedIndex].text : '';
        if (!tipoConfere(atual, tipo)) throw new Error(`Conferência falhou: Tipo do ${descricao} deveria ser "${tipo}", mas está "${atual}"`);
    }

    function lerGridDependentes() {
        let fs = fieldsetPorLegenda('Dependentes do Servidor');
        return (lerTabela(fs, ['nome', 'tipo']) || []).map(l => ({
            nome: l['nome'], tipo: l['tipo'], valor: l['valor'], percentual: l['percentual e.']
        }));
    }

    // Espera o grid carregar e ficar estável (2 leituras iguais seguidas)
    async function lerGridDependentesEstavel() {
        await esperarAte(() => {
            let fs = fieldsetPorLegenda('Dependentes do Servidor');
            return fs && /total de registros/.test(textoNorm(fs.textContent));
        }, 'o grid "Dependentes do Servidor" carregar');
        let anterior = null;
        for (let i = 0; i < 10; i++) {
            await esperar(400);
            let atual = lerGridDependentes();
            let assinatura = JSON.stringify(atual.map(l => [l.nome, l.tipo, l.valor, l.percentual]));
            if (assinatura === anterior) return atual;
            anterior = assinatura;
        }
        return lerGridDependentes();
    }

    function situacaoNoGrid(grid, nome, dep) {
        let linhas = filtrarPorNome(grid, l => l.nome, nome);
        if (!linhas.length) return { status: 'ausente' };
        if (linhas.length > 1) return { status: 'ambiguo', linhas };
        let l = linhas[0];
        let igual = tipoConfere(l.tipo, dep.tipo) && parseCentavos(l.valor) === parseCentavos(dep.valor) &&
            (l.percentual === undefined || parseCentavos(l.percentual) === parseCentavos(dep.percentual));
        return { status: igual ? 'igual' : 'diferente', linha: l };
    }

    function descreverLinhaGrid(l) {
        return `${l.nome}: ${l.tipo}, ${l.valor}, ${l.percentual || '?'}`;
    }

    // =========================================================================
    // POPUP "PESQUISAR DEPENDENTES"
    // =========================================================================
    function acharPopupDependentes() {
        for (let d of documentosAcessiveis()) {
            if (d === document || !d.body || !frameVisivel(d)) continue;
            let linhas = lerTabela(d.body, ['nome do dependente']);
            if (linhas === null) continue;
            let semRegistros = /retornados 0 registro|nenhum registro/.test(textoNorm(d.body.textContent));
            if (linhas.length || semRegistros) return { doc: d, linhas };
        }
        return null;
    }

    function fecharPopup(popup) {
        try {
            let fechar = botaoNoDoc(popup.doc, 'Fechar');
            if (fechar) fechar.click();
        } catch (e) { /* popup já fechado */ }
    }

    async function escolherNoPopup(popup, dep, reg, rotulo) {
        for (let pagina = 1; pagina <= 10; pagina++) {
            let doServidor = popup.linhas.filter(l => !l['matricula do servidor'] || l['matricula do servidor'] === reg.matricula);
            let porNome = filtrarPorNome(doServidor, l => l['nome do dependente'], dep.nome);
            let candidatos = dep.nascimento
                ? porNome.filter(l => !l['data de nascimento'] || l['data de nascimento'] === dep.nascimento)
                : porNome;
            if (candidatos.length === 1) return candidatos[0];
            if (candidatos.length > 1) {
                fecharPopup(popup);
                throw new Error(`${rotulo}: ${candidatos.length} registros possíveis no popup (${candidatos.map(l => l['codigo'] + ' ' + l['nome do dependente']).join(', ')})`);
            }
            if (porNome.length) {
                fecharPopup(popup);
                throw new Error(`${rotulo}: nome achado no popup, mas a data de nascimento não confere (PDF ${dep.nascimento} x sistema ${porNome.map(l => l['data de nascimento']).join(', ')})`);
            }
            let proximo = botaoNoDoc(popup.doc, 'Próximo');
            if (!proximo || proximo.disabled) break;
            let assinatura = popup.linhas.map(l => l._tr.textContent).join('|');
            proximo.click();
            popup = await esperarAte(() => {
                let p = acharPopupDependentes();
                return p && p.linhas.map(l => l._tr.textContent).join('|') !== assinatura ? p : null;
            }, 'a próxima página do popup');
        }
        let listados = popup.linhas.map(l => l['nome do dependente']).join(', ');
        fecharPopup(popup);
        throw new Error(`${rotulo} não encontrado no popup "Pesquisar Dependentes" (listados: ${listados || 'nenhum'})`);
    }

    function clicarLinhaPopup(linha) {
        let celula = linha._cel['nome do dependente'] || linha._tr.cells[0];
        let alvo = celula.querySelector('a') || linha._tr.querySelector('a') || celula;
        alvo.click();
    }

    // =========================================================================
    // ROBÔ: TITULAR
    // =========================================================================
    async function carregarServidor(reg, competencia) {
        let t = elementosTitular();
        exigirCampos(t, ['codigo', 'competencia'], 'Titular');
        lerAlerta();
        preencherCampo(t.codigo, reg.matricula);
        dispararEnter(t.codigo);
        try {
            await esperarAte(() => {
                if (espiarAlerta()) return true;
                let n = elementosTitular().nome;
                return !n || (n.value.trim() && nomesBatem(n.value, reg.nome));
            }, `carregar a matrícula ${reg.matricula}`);
        } catch (e) {
            let n = elementosTitular().nome;
            throw new Error(`Nome do servidor na tela ("${n ? n.value : ''}") não confere com o CSV ("${reg.nome}")`);
        }
        let alerta = lerAlerta();
        if (alerta) throw new Error('Sistema recusou a matrícula: ' + alerta);
        await esperar(TEMPO_ESPERA_MATRICULA);

        let opcaoDe = sel => Array.from(sel.options).find(o => o.text.includes(competencia) || o.value.includes(competencia));
        await esperarAte(() => {
            let c = elementosTitular().competencia;
            return c && (c.tagName !== 'SELECT' || opcaoDe(c));
        }, `a competência ${competencia} aparecer na lista`);
        let campo = elementosTitular().competencia;
        if (campo.tagName === 'SELECT') {
            let opcao = opcaoDe(campo);
            if (campo.value !== opcao.value) {
                campo.value = opcao.value;
                dispararEventos(campo);
                await esperar(TEMPO_ESPERA_MATRICULA);
            }
            let atual = campo.options[campo.selectedIndex];
            if (!atual || !atual.text.includes(competencia)) throw new Error(`Conferência falhou: competência selecionada "${atual ? atual.text : ''}"`);
        } else if (campo.value !== competencia) {
            preencherCampo(campo, competencia);
            await esperar(TEMPO_ESPERA_MATRICULA);
        }
    }

    async function salvarTitular(reg, competencia) {
        let t = elementosTitular();
        exigirCampos(t, ['salvar'], 'Titular');
        lerAlerta();
        t.salvar.click();
        await esperarAte(() => espiarAlerta(), 'resposta ao salvar', TEMPO_ESPERA_POS_SALVAR * 3).catch(() => null);
        let alerta = lerAlerta();
        if (alerta && REGEX_ALERTA_ERRO.test(alerta)) throw new Error('Sistema recusou o titular: ' + alerta);

        // Conferência pós-salvar: recarrega o servidor e confere o que ficou gravado
        await carregarServidor(reg, competencia);
        let gravado = elementosTitular();
        conferirCampo(gravado.valor, reg.titular.valor, 'Valor do titular (após salvar)');
        conferirCampo(gravado.percentual, reg.titular.percentual, 'Percentual do titular (após salvar)');
        registrarLog('ok', reg.matricula, `Titular salvo e conferido (R$ ${reg.titular.valor} / ${reg.titular.percentual}%)` +
            (alerta ? ` — Sistema: ${alerta}` : ''));
    }

    // =========================================================================
    // ROBÔ: DEPENDENTE (aba "Dependentes")
    // =========================================================================
    async function lancarDependente(dep, ordem, reg, autoSalvar) {
        let rotulo = `dependente ${ordem} (${dep.nome})`;
        let e = elementosDependente();
        exigirCampos(e, ['link', 'codigo', 'nome', 'tipo', 'valor', 'percentual', 'salvar'], rotulo);

        // 1. Formulário limpo
        if (e.codigo.value.trim() || e.nome.value.trim()) {
            if (!e.novo) throw new Error(`${rotulo}: formulário com dados e botão "Novo" não encontrado`);
            e.novo.click();
            await esperarAte(() => {
                let x = elementosDependente();
                return x.codigo && !x.codigo.value.trim() && !x.nome.value.trim();
            }, 'limpar o formulário do dependente (Novo)');
        }

        // 2. Link azul "Dependente:" -> popup "Pesquisar Dependentes"
        elementosDependente().link.click();
        let popup = await esperarAte(acharPopupDependentes, 'o popup "Pesquisar Dependentes" carregar');
        protegerAlertasDosFrames();
        let linha = await escolherNoPopup(popup, dep, reg, rotulo);
        let nomeSistema = linha['nome do dependente'];
        let codigoSistema = linha['codigo'] || '';
        clicarLinhaPopup(linha);
        await esperarAte(() => {
            let x = elementosDependente();
            return x.nome && x.nome.value.trim() && nomesBatem(x.nome.value, nomeSistema) &&
                (!codigoSistema || x.codigo.value.trim() === codigoSistema);
        }, `o ${rotulo} voltar do popup para o formulário`);
        await esperarAte(() => !acharPopupDependentes(), 'o popup fechar', 5000).catch(() => null);
        checarParada();

        // 3. Tipo (somente cônjuge / filho(a) ou enteado(a))
        e = elementosDependente();
        selecionarTipo(e.tipo, dep.tipo, rotulo);
        await esperar(TEMPO_ESPERA_CAMPO);

        // 4. Valor e percentual
        e = elementosDependente();
        await preencherEConferir(e.valor, dep.valor, `Valor do ${rotulo}`);
        await preencherEConferir(e.percentual, dep.percentual, `Percentual do ${rotulo}`);

        // Conferência completa antes de salvar
        e = elementosDependente();
        if (!nomesBatem(e.nome.value, nomeSistema)) throw new Error(`Conferência falhou: dependente na tela "${e.nome.value}" ≠ "${nomeSistema}"`);
        conferirTipo(e.tipo, dep.tipo, rotulo);
        conferirCampo(e.valor, dep.valor, `Valor do ${rotulo}`);
        conferirCampo(e.percentual, dep.percentual, `Percentual do ${rotulo}`);
        checarParada();

        if (!autoSalvar) throw new PausaRevisao(`${rotulo} preenchido. Revise, clique em Salvar e depois em ▶ Iniciar.`);

        // 5. Salvar o dependente e conferir no grid
        lerAlerta();
        e.salvar.click();
        let resultado;
        try {
            resultado = await esperarAte(() => {
                let a = espiarAlerta();
                if (a && REGEX_ALERTA_ERRO.test(a)) return { erro: a };
                return situacaoNoGrid(lerGridDependentes(), nomeSistema, dep).status === 'igual' ? { ok: true } : null;
            }, `o ${rotulo} aparecer no grid "Dependentes do Servidor"`, TEMPO_LIMITE_SALVAR);
        } catch (err) {
            let s = situacaoNoGrid(lerGridDependentes(), nomeSistema, dep);
            throw new Error(err.message + (s.linha ? ` (no grid está: ${descreverLinhaGrid(s.linha)})` : ' (não apareceu no grid)'));
        }
        let alerta = lerAlerta();
        if (resultado.erro) throw new Error(`Sistema recusou o ${rotulo}: ${resultado.erro}`);
        registrarLog('ok', reg.matricula, `Dependente "${nomeSistema}" salvo e conferido no grid (${dep.tipo}, R$ ${dep.valor}, ${dep.percentual}%)` +
            (alerta ? ` — Sistema: ${alerta}` : ''));
    }

    // =========================================================================
    // ROBÔ: PROCESSA UMA MATRÍCULA (idempotente: pode ser repetido após uma pausa)
    // =========================================================================
    let ocupado = false;

    async function processarRegistro(reg) {
        let competencia = localStorage.getItem(K_COMPETENCIA) || '';
        if (!/^\d{2}\/\d{4}$/.test(competencia)) throw new Error('Informe a competência no formato MM/AAAA');
        let autoSalvar = localStorage.getItem(K_AUTO_SALVAR) === 'sim';
        protegerAlertasDosFrames();

        // 1. Aba do titular + matrícula + competência
        mostrarAtual(`Mat. ${reg.matricula}: carregando servidor...`);
        await irParaAba('Planos de Saúde', 'Plano de Saúde do Servidor');
        await carregarServidor(reg, competencia);
        checarParada();

        // 2. Titular
        let t = elementosTitular();
        exigirCampos(t, ['valor', 'percentual'], 'Titular');
        let titularCorreto = parseCentavos(t.valor.value) === parseCentavos(reg.titular.valor) &&
            parseCentavos(t.percentual.value) === parseCentavos(reg.titular.percentual);

        if (titularCorreto && localStorage.getItem(K_PULAR_LANCADOS) !== 'nao') {
            registrarLog('info', reg.matricula, `Titular já correto (R$ ${reg.titular.valor} / ${reg.titular.percentual}%)`);
        } else {
            mostrarAtual(`Mat. ${reg.matricula}: titular R$ ${reg.titular.valor}`);
            await preencherEConferir(t.valor, reg.titular.valor, 'Valor do titular');
            await preencherEConferir(t.percentual, reg.titular.percentual, 'Percentual do titular');
            conferirCampo(t.valor, reg.titular.valor, 'Valor do titular'); // o percentual pode recalcular a tela
            checarParada();
            if (!autoSalvar) throw new PausaRevisao('Titular preenchido. Revise, clique em Salvar e depois em ▶ Iniciar.');
            await salvarTitular(reg, competencia);
        }

        if (!reg.dependentes.length) {
            if (titularCorreto) registrarLog('ok', reg.matricula, 'Sem dependentes e titular já correto — avançando');
            return;
        }

        // 3. Dependentes
        checarParada();
        mostrarAtual(`Mat. ${reg.matricula}: abrindo aba Dependentes...`);
        await irParaAba('Dependentes', 'Dependente');
        let grid = await lerGridDependentesEstavel();

        for (let i = 0; i < reg.dependentes.length; i++) {
            checarParada();
            let d = reg.dependentes[i];
            mostrarAtual(`Mat. ${reg.matricula}: dependente ${i + 1}/${reg.dependentes.length} (${d.nome})`);
            let situacao = situacaoNoGrid(grid, d.nome, d);
            if (situacao.status === 'igual') {
                registrarLog('info', reg.matricula, `Dependente "${situacao.linha.nome}" já lançado corretamente`);
                continue;
            }
            if (situacao.status === 'diferente') {
                throw new Error(`Dependente já está no grid com dados diferentes — grid: ${descreverLinhaGrid(situacao.linha)} | PDF: ${d.tipo}, R$ ${d.valor}, ${d.percentual}%. Corrija manualmente (botão "A")`);
            }
            if (situacao.status === 'ambiguo') {
                throw new Error(`Dependente "${d.nome}" casa com mais de uma linha do grid: ${situacao.linhas.map(descreverLinhaGrid).join(' / ')}`);
            }
            await lancarDependente(d, i + 1, reg, autoSalvar);
            grid = await lerGridDependentesEstavel();
        }

        let extras = grid.filter(l => !reg.dependentes.some(d => filtrarPorNome([l], x => x.nome, d.nome).length));
        if (extras.length) registrarLog('aviso', reg.matricula, `No grid, mas não no PDF (não alterados): ${extras.map(l => l.nome).join(', ')}`);

        await irParaAba('Planos de Saúde', 'Plano de Saúde do Servidor');
        registrarLog('ok', reg.matricula, `Concluído: titular + ${reg.dependentes.length} dependente(s) conferidos`);
    }

    async function cicloRobo() {
        if (ocupado) return;
        if (localStorage.getItem(K_STATUS) !== 'rodando') return;
        if (!document.getElementById(ID_CODIGO)) return;

        let dados = JSON.parse(localStorage.getItem(K_DADOS) || '[]');
        let index = parseInt(localStorage.getItem(K_INDEX) || '0', 10);

        if (index >= dados.length) {
            localStorage.setItem(K_STATUS, 'parado');
            mostrarAtual('Concluído! Todos os registros foram processados.');
            atualizarPainel();
            return;
        }

        ocupado = true;
        let reg = dados[index];
        try {
            if (reg.dependentes.some(d => !d.nascimento || d.percentual !== percentualDependentePorTipo(d.tipo))) {
                throw new Error('Lista gerada por versão antiga do robô. Clique de novo em "⚙ Cruzar e Validar Arquivos".');
            }
            await processarRegistro(reg);
            localStorage.setItem(K_INDEX, String(index + 1));
        } catch (e) {
            localStorage.setItem(K_STATUS, 'parado');
            if (e instanceof PausaRevisao) {
                registrarLog('aviso', reg.matricula, e.message);
            } else {
                console.error(e);
                registrarLog('erro', reg.matricula, e.message + ' — robô PAUSADO. Corrija e use ▶ Iniciar (repete) ou Avançar ⏩ (pula).');
            }
        } finally {
            ocupado = false;
            atualizarPainel();
        }
    }

    // =========================================================================
    // LOG
    // =========================================================================
    function registrarLog(nivel, matricula, mensagem) {
        let log = JSON.parse(localStorage.getItem(K_LOG) || '[]');
        log.push({ h: new Date().toLocaleTimeString('pt-BR'), nivel, matricula, mensagem });
        if (log.length > 2000) log = log.slice(-2000);
        localStorage.setItem(K_LOG, JSON.stringify(log));
        renderizarLog();
    }

    function renderizarLog() {
        let caixa = document.getElementById('ecps-log');
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
        let nErros = log.filter(l => l.nivel === 'erro').length;
        let cont = document.getElementById('ecps-qtd-erros');
        if (cont) cont.textContent = nErros;
    }

    function baixarArquivo(nome, conteudo) {
        let blob = new Blob(['﻿' + conteudo], { type: 'text/csv;charset=utf-8' });
        let a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = nome;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    // Lista todos os campos da tela (e iframes internos) para descobrir os IDs reais
    function diagnosticoCampos() {
        let linhas = ['DOC;URL;TAG;TYPE;ID;NAME;VISIVEL;VALOR;TEXTO/OPCOES'];
        documentosAcessiveis().forEach((d, n) => {
            let url = (d.location ? d.location.pathname : '').split('/').pop();
            d.querySelectorAll('input, select, textarea, button, a, legend').forEach(el => {
                if (el.closest('#painel-ecps')) return;
                let texto = el.tagName === 'SELECT'
                    ? Array.from(el.options).map(o => o.text.trim()).join(' | ')
                    : (el.textContent || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
                linhas.push([n, url, el.tagName, el.type || '', el.id, el.name || '', visivel(el) ? 'S' : 'N', (el.value || '').slice(0, 40), texto].join(';'));
            });
        });
        let saida = linhas.join('\r\n');
        console.log(saida);
        baixarArquivo('diagnostico_campos_plano_saude.csv', saida);
    }

    // =========================================================================
    // PAINEL FLUTUANTE
    // =========================================================================
    function gerenciarPainel() {
        let campoCodigo = document.getElementById(ID_CODIGO);
        let painelAtual = document.getElementById('painel-ecps');

        if (!campoCodigo) {
            if (painelAtual) painelAtual.remove();
            return;
        }
        if (painelAtual) {
            atualizarPainel();
            return;
        }

        const estiloBtn = 'flex:1; color:#fff; border:none; padding:5px; border-radius:4px; cursor:pointer; font-size:12px;';
        let div = document.createElement('div');
        div.id = 'painel-ecps';
        div.innerHTML = `
            <div style="position:fixed; bottom:20px; right:20px; background:#fff; border:2px solid #0056b3; padding:15px; border-radius:8px; z-index:999999; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-family: Arial, sans-serif; font-size: 14px; width: 340px; max-height: 95vh; overflow-y: auto; box-sizing: border-box;">
                <h3 style="margin: 0 0 10px 0; font-size: 16px; color: #0056b3;">Robô - Plano de Saúde (CSV x PDF IPE)</h3>

                <label style="display:block; margin-bottom: 5px; font-size: 12px;"><strong>Competência (Ex: 09/2025):</strong></label>
                <input type="text" id="ecps-comp-input" placeholder="MM/AAAA" maxlength="7" style="width: 100%; margin-bottom: 10px; padding: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;">

                <label style="display:block; margin-bottom: 5px; font-size: 12px;"><strong>1. Planilha CSV (rubrica R963)</strong></label>
                <input type="file" id="ecps-csv" accept=".csv" style="display:block; margin-bottom: 10px; width: 100%; font-size: 12px;">

                <label style="display:block; margin-bottom: 5px; font-size: 12px;"><strong>2. PDF de Contribuições IPE Saúde</strong></label>
                <input type="file" id="ecps-pdf" accept=".pdf" style="display:block; margin-bottom: 10px; width: 100%; font-size: 12px;">

                <button id="ecps-btn-processar" style="${estiloBtn} width:100%; background:#0056b3; padding:8px; font-weight:bold; margin-bottom:10px;">⚙ 3. Cruzar e Validar Arquivos</button>

                <label style="display:block; font-size: 12px; margin-bottom: 3px;"><input type="checkbox" id="ecps-auto-salvar"> Clicar em <strong>Salvar</strong> automaticamente</label>
                <label style="display:block; font-size: 12px; margin-bottom: 10px;"><input type="checkbox" id="ecps-pular"> Pular titular já correto (67,73% <u>e</u> valor)</label>

                <div style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin-bottom: 10px; border: 1px solid #ddd;">
                    <p style="margin: 0 0 5px 0;">Status: <strong id="ecps-status-texto" style="color:#dc3545;">Parado</strong></p>
                    <p style="margin: 0 0 5px 0; font-size: 12px;" id="ecps-resumo"></p>
                    <p style="margin: 0 0 5px 0;">Progresso: <strong id="ecps-linha">0 / 0</strong> &nbsp;|&nbsp; Erros: <strong id="ecps-qtd-erros" style="color:#dc3545;">0</strong></p>
                    <p style="margin: 0; font-size: 12px; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" id="ecps-dados-atuais">Nenhum dado</p>
                    <p style="margin: 3px 0 0 0; font-size: 11px; color: #555; white-space: normal;" id="ecps-detalhe"></p>
                </div>

                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <button id="ecps-btn-play" style="flex:1; background: #28a745; color: #fff; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight:bold;">▶ Iniciar</button>
                    <button id="ecps-btn-pause" style="flex:1; background: #dc3545; color: #fff; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight:bold;">⏸ Parar</button>
                </div>

                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <button id="ecps-btn-prev" style="${estiloBtn} background: #6c757d;">⏪ Voltar</button>
                    <button id="ecps-btn-next" style="${estiloBtn} background: #17a2b8;">Avançar ⏩</button>
                </div>

                <div id="ecps-log" style="height: 110px; overflow-y: auto; font-size: 11px; border: 1px solid #ddd; border-radius: 4px; padding: 4px; margin-bottom: 8px; background:#fcfcfc;"></div>

                <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                    <button id="ecps-btn-csv" style="${estiloBtn} background: #343a40;">⬇ CSV gerado</button>
                    <button id="ecps-btn-erros" style="${estiloBtn} background: #343a40;">⬇ Erros</button>
                    <button id="ecps-btn-diag" style="${estiloBtn} background: #343a40;">🔎 Diagnóstico</button>
                </div>
            </div>
        `;
        document.body.appendChild(div);

        let inputComp = document.getElementById('ecps-comp-input');
        inputComp.addEventListener('input', function() {
            let v = this.value.replace(/\D/g, '');
            if (v.length > 2) v = v.substring(0, 2) + '/' + v.substring(2, 6);
            this.value = v;
            localStorage.setItem(K_COMPETENCIA, this.value);
        });
        inputComp.value = localStorage.getItem(K_COMPETENCIA) || '';

        let chkSalvar = document.getElementById('ecps-auto-salvar');
        chkSalvar.checked = localStorage.getItem(K_AUTO_SALVAR) === 'sim';
        chkSalvar.addEventListener('change', () => localStorage.setItem(K_AUTO_SALVAR, chkSalvar.checked ? 'sim' : 'nao'));

        let chkPular = document.getElementById('ecps-pular');
        chkPular.checked = localStorage.getItem(K_PULAR_LANCADOS) !== 'nao';
        chkPular.addEventListener('change', () => localStorage.setItem(K_PULAR_LANCADOS, chkPular.checked ? 'sim' : 'nao'));

        document.getElementById('ecps-btn-processar').addEventListener('click', processarArquivos);
        document.getElementById('ecps-btn-play').addEventListener('click', () => {
            if (!/^\d{2}\/\d{4}$/.test(localStorage.getItem(K_COMPETENCIA) || '')) {
                alertaPainel('Informe a competência no formato MM/AAAA.');
                return;
            }
            localStorage.setItem(K_STATUS, 'rodando');
            atualizarPainel();
        });
        document.getElementById('ecps-btn-pause').addEventListener('click', () => { localStorage.setItem(K_STATUS, 'parado'); atualizarPainel(); });
        document.getElementById('ecps-btn-next').addEventListener('click', () => alterarIndice(1));
        document.getElementById('ecps-btn-prev').addEventListener('click', () => alterarIndice(-1));
        document.getElementById('ecps-btn-csv').addEventListener('click', () => {
            let dados = JSON.parse(localStorage.getItem(K_DADOS) || '[]');
            baixarArquivo('plano_saude_processado.csv', gerarCsvProcessado(dados));
        });
        document.getElementById('ecps-btn-erros').addEventListener('click', () => {
            let erros = JSON.parse(localStorage.getItem(K_ERROS_CRUZAMENTO) || '[]');
            let log = JSON.parse(localStorage.getItem(K_LOG) || '[]').filter(l => l.nivel === 'erro' || l.nivel === 'aviso');
            let linhas = ['ORIGEM;MATRICULA;NOME;VALOR_CSV;MOTIVO'];
            erros.forEach(e => linhas.push(['cruzamento', e.matricula, e.nome, e.valorCsv, e.motivo].join(';')));
            log.filter(l => !erros.some(e => l.mensagem.startsWith(e.nome + ':')))
                .forEach(l => linhas.push(['robo ' + l.h, l.matricula, '', '', l.mensagem].join(';')));
            baixarArquivo('plano_saude_erros.csv', linhas.join('\r\n'));
        });
        document.getElementById('ecps-btn-diag').addEventListener('click', diagnosticoCampos);

        renderizarLog();
        atualizarPainel();
    }

    function alterarIndice(delta) {
        let dados = JSON.parse(localStorage.getItem(K_DADOS) || '[]');
        let index = parseInt(localStorage.getItem(K_INDEX) || '0', 10);
        index += delta;
        if (index >= dados.length) index = dados.length - 1;
        if (index < 0) index = 0;
        localStorage.setItem(K_INDEX, index.toString());
        localStorage.setItem(K_ETAPA, '');
        atualizarPainel();
    }

    function mostrarAtual(texto) {
        let el = document.getElementById('ecps-dados-atuais');
        if (el) el.textContent = texto;
    }

    function atualizarPainel() {
        let statusElement = document.getElementById('ecps-status-texto');
        let linhaElement = document.getElementById('ecps-linha');
        let detalheElement = document.getElementById('ecps-detalhe');
        if (!statusElement) return;
        document.getElementById('ecps-resumo').textContent = localStorage.getItem(K_RESUMO) || 'Arquivos ainda não processados';

        let status = localStorage.getItem(K_STATUS) || 'parado';
        let dados = JSON.parse(localStorage.getItem(K_DADOS) || '[]');
        let index = parseInt(localStorage.getItem(K_INDEX) || '0', 10);

        if (status === 'rodando') {
            statusElement.textContent = 'RODANDO 🟢';
            statusElement.style.color = '#28a745';
        } else {
            statusElement.textContent = 'PARADO 🔴';
            statusElement.style.color = '#dc3545';
        }

        if (dados.length > 0) {
            linhaElement.textContent = `${Math.min(index + 1, dados.length)} de ${dados.length}`;
            if (index < dados.length) {
                let r = dados[index];
                if (!ocupado) mostrarAtual(`Matrícula em foco: ${r.matricula} - ${r.nome}`);
                detalheElement.textContent = `Titular R$ ${r.titular.valor} (${r.titular.percentual}%)` +
                    r.dependentes.map(d => ` + ${d.tipo} R$ ${d.valor} (${d.percentual}%)`).join('') + ` = R$ ${r.valorCsv}`;
            } else {
                detalheElement.textContent = 'Fim da lista.';
            }
        }
    }

    // Loop de controle
    setInterval(() => {
        gerenciarPainel();
        cicloRobo();
    }, TEMPO_LOOP);
})();

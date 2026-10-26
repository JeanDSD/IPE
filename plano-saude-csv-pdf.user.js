// ==UserScript==
// @name         Plano de Saúde - Cruzamento CSV x PDF IPE e Lançamento Automático
// @namespace    http://tampermonkey.net/
// @version      5.1
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
    const TEMPO_ESPERA_MATRICULA = 1500;
    const TEMPO_ESPERA_CAMPO = 300;
    const TEMPO_ESPERA_DEPENDENTE = 1000;
    const TEMPO_ESPERA_POS_SALVAR = 1000;
    const TEMPO_ESPERA_POS_POPUP = 1000;

    const MAX_TENTATIVAS_COMPETENCIA = 5;

    // =========================================================================
    // IDS / SELETORES DA TELA "PLANO DE SAÚDE" (pes1_plano_saude_servidor001.php)
    // =========================================================================
    const ID_COMPETENCIA = 'competencia';
    const ID_CODIGO = 'codigoServidor';
    const ID_VALOR = 'valorServidor';
    const ID_PERCENTUAL = 'percentualEmpregadorSe';
    const ID_SALVAR = 'salvarServidorOperadoraSaude';

    // Campos dos dependentes. Deixe null para o robô localizar sozinho (heurística).
    // Se a detecção automática falhar, use o botão "🔎 Diagnóstico" do painel,
    // descubra os IDs reais e informe-os aqui (ex: '#tipoDependente').
    const SELETORES_DEPENDENTE = {
        botaoAdicionar: null,   // botão que adiciona/inclui o dependente
        tipo: null,             // <select> do tipo (filho ou enteado / cônjuge)
        percentual: null,       // input do percentual do dependente
        valor: null             // input do valor do dependente
    };
    // 'auto'                      -> detecta sozinho
    // 'adicionar-depois-preencher'-> clica em adicionar, aparece uma linha nova, preenche a linha
    // 'preencher-depois-adicionar'-> preenche o formulário do dependente e depois clica em adicionar
    const MODO_DEPENDENTE = 'auto';

    // =========================================================================
    // REGRAS DE NEGÓCIO
    // =========================================================================
    const PERCENTUAL_TITULAR = '67,73';
    const PERCENTUAL_DEPENDENTE = '0';
    const IDADE_MAIORIDADE = 18;
    const TIPO_FILHO = 'filho ou enteado';
    const TIPO_CONJUGE = 'cônjuge';
    const REGEX_OPCAO_FILHO = /filho|enteado/i;
    const REGEX_OPCAO_CONJUGE = /c[oô]njuge/i;

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

    // =========================================================================
    // <<NUCLEO>> PROCESSAMENTO DOS ARQUIVOS (funções puras, sem DOM)
    // =========================================================================
    const REGEX_LINHA_PDF = /^(.+?)\s+(Titular Ativo|Titular Inativo|Titular|Pensionista|Dependente)\s+(?:(\d{3}\.\d{3}\.\d{3}-\d{2})\s+)?(\d{6,})\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{1,3})\s+(.+?)\s+R\$\s*([\d.]+,\d{2})$/i;
    const PARTICULAS = ['DE', 'DA', 'DO', 'DOS', 'DAS', 'E', 'D'];

    function parseCentavos(valorString) {
        if (valorString === null || valorString === undefined) return 0;
        let limpo = valorString.toString().replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
        let num = parseFloat(limpo);
        return isNaN(num) ? 0 : Math.round(num * 100);
    }

    function formatCentavos(centavos) {
        return (centavos / 100).toFixed(2).replace('.', ',');
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
                    tipo: tipoDependentePorIdade(d.idade),
                    percentual: PERCENTUAL_DEPENDENTE,
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

    // Documento atual + iframes internos do mesmo domínio (janelas auxiliares do e-cidade)
    function documentosAcessiveis(doc = document, acc = []) {
        acc.push(doc);
        for (let f of doc.querySelectorAll('iframe, frame')) {
            try { if (f.contentDocument) documentosAcessiveis(f.contentDocument, acc); } catch (e) { /* outro domínio */ }
        }
        return acc;
    }

    function buscar(seletor) {
        for (let d of documentosAcessiveis()) {
            let el = d.querySelector(seletor);
            if (el) return el;
        }
        return null;
    }

    function textoElemento(el) {
        return normalizarNome(el.value || el.textContent || el.title || '').toLowerCase();
    }

    function selecionarOpcao(select, regex) {
        let opcao = Array.from(select.options).find(o => regex.test(o.text.normalize('NFC')) || regex.test(o.value));
        if (!opcao) return false;
        select.value = opcao.value;
        dispararEventos(select);
        return true;
    }

    function selecionarCompetencia(idCampo, competenciaDesejada) {
        let campoCompetencia = document.getElementById(idCampo);
        if (!campoCompetencia || !competenciaDesejada) return false;
        let encontrou = false;

        if (campoCompetencia.tagName === 'SELECT') {
            let opcoes = Array.from(campoCompetencia.options);
            let optionAlvo = opcoes.find(opt => opt.text.includes(competenciaDesejada) || opt.value.includes(competenciaDesejada));
            if (optionAlvo) {
                if (campoCompetencia.value !== optionAlvo.value) {
                    campoCompetencia.value = optionAlvo.value;
                    encontrou = true;
                } else {
                    return true;
                }
            }
        } else {
            if (campoCompetencia.value !== competenciaDesejada) {
                campoCompetencia.value = competenciaDesejada;
                encontrou = true;
            } else {
                return true;
            }
        }

        if (encontrou) { dispararEventos(campoCompetencia); }
        return encontrou;
    }

    // Captura os alert() do e-cidade enquanto o robô roda, para não travar o loop
    let ultimoAlerta = null;
    const alertOriginal = window.alert;
    window.alert = function(msg) {
        if (localStorage.getItem(K_STATUS) === 'rodando') {
            ultimoAlerta = String(msg);
            console.log('[Robô Plano de Saúde] alert capturado:', msg);
            return;
        }
        return alertOriginal.call(window, msg);
    };

    function alertaPainel(msg) {
        alertOriginal.call(window, msg);
    }

    // =========================================================================
    // LOCALIZAÇÃO DOS CAMPOS DE DEPENDENTE
    // =========================================================================
    function selectsDeTipoDependente() {
        let lista = [];
        for (let d of documentosAcessiveis()) {
            for (let s of d.querySelectorAll('select')) {
                if (!visivel(s)) continue;
                let textos = Array.from(s.options).map(o => o.text);
                if (textos.some(t => REGEX_OPCAO_FILHO.test(t)) && textos.some(t => REGEX_OPCAO_CONJUGE.test(t))) lista.push(s);
            }
        }
        return lista;
    }

    function localizarBotaoAdicionarDependente() {
        if (SELETORES_DEPENDENTE.botaoAdicionar) return buscar(SELETORES_DEPENDENTE.botaoAdicionar);
        let candidatos = [];
        for (let d of documentosAcessiveis()) {
            candidatos.push(...d.querySelectorAll('button, input[type=button], input[type=submit], a, [onclick]'));
        }
        candidatos = candidatos.filter(b => visivel(b) && b.id !== ID_SALVAR && !b.closest('#painel-ecps'));
        let porDependente = candidatos.find(b => /(adicionar|incluir|novo|lancar|\+).*dependente|dependente.*(adicionar|incluir|novo)/.test(textoElemento(b) + ' ' + (b.id || '').toLowerCase()));
        if (porDependente) return porDependente;
        return candidatos.find(b => /dependente/i.test((b.id || '') + ' ' + (b.name || '') + ' ' + textoElemento(b))) || null;
    }

    // A partir do <select> de tipo, acha percentual e valor na mesma linha/bloco
    function camposDoDependente(selectTipo) {
        let tipo = SELETORES_DEPENDENTE.tipo ? buscar(SELETORES_DEPENDENTE.tipo) : selectTipo;
        let percentual = SELETORES_DEPENDENTE.percentual ? buscar(SELETORES_DEPENDENTE.percentual) : null;
        let valor = SELETORES_DEPENDENTE.valor ? buscar(SELETORES_DEPENDENTE.valor) : null;
        if (tipo && (!percentual || !valor)) {
            let container = tipo.closest('tr') || tipo.parentElement;
            while (container && (!percentual || !valor)) {
                let inputs = Array.from(container.querySelectorAll('input[type=text], input:not([type])'))
                    .filter(i => visivel(i) && i.id !== ID_VALOR && i.id !== ID_PERCENTUAL && !i.closest('#painel-ecps'));
                let idNome = i => ((i.id || '') + ' ' + (i.name || '')).toLowerCase();
                percentual = percentual || inputs.find(i => /percent|perc/.test(idNome(i)));
                valor = valor || inputs.find(i => /valor|vlr/.test(idNome(i)));
                if (container.tagName === 'FORM' || container.tagName === 'BODY') break;
                container = container.parentElement;
            }
        }
        return { tipo, percentual, valor };
    }

    async function lancarDependente(dep, ordem, matricula) {
        let regexTipo = dep.tipo === TIPO_FILHO ? REGEX_OPCAO_FILHO : REGEX_OPCAO_CONJUGE;
        let antes = selectsDeTipoDependente();
        let modo = MODO_DEPENDENTE;
        if (modo === 'auto') {
            // Se já existe um formulário de dependente vazio na tela, é "preencher e depois adicionar"
            let vazio = antes.find(s => !s.value || s.selectedIndex <= 0);
            modo = (vazio || SELETORES_DEPENDENTE.tipo) ? 'preencher-depois-adicionar' : 'adicionar-depois-preencher';
        }

        let botao = localizarBotaoAdicionarDependente();
        let alvo;
        if (modo === 'adicionar-depois-preencher') {
            if (!botao) throw new Error('Botão de adicionar dependente não encontrado');
            botao.click();
            await esperar(TEMPO_ESPERA_DEPENDENTE);
            let depois = selectsDeTipoDependente();
            alvo = depois.find(s => !antes.includes(s)) || depois[depois.length - 1];
        } else {
            alvo = antes.find(s => !s.value || s.selectedIndex <= 0) || antes[antes.length - 1];
        }
        if (!alvo && !SELETORES_DEPENDENTE.tipo) throw new Error(`Campo "Tipo" do dependente ${ordem} não encontrado`);

        let campos = camposDoDependente(alvo);
        if (!campos.tipo || !campos.percentual || !campos.valor) {
            throw new Error(`Campos do dependente ${ordem} incompletos (tipo:${!!campos.tipo} percentual:${!!campos.percentual} valor:${!!campos.valor})`);
        }
        if (!selecionarOpcao(campos.tipo, regexTipo)) throw new Error(`Opção "${dep.tipo}" não existe no select`);
        await esperar(TEMPO_ESPERA_CAMPO);
        preencherCampo(campos.percentual, dep.percentual);
        await esperar(TEMPO_ESPERA_CAMPO);
        preencherCampo(campos.valor, dep.valor);
        await esperar(TEMPO_ESPERA_CAMPO);

        let tipoOk = regexTipo.test(campos.tipo.options[campos.tipo.selectedIndex].text);
        if (!tipoOk || parseCentavos(campos.valor.value) !== parseCentavos(dep.valor) || parseCentavos(campos.percentual.value) !== parseCentavos(dep.percentual)) {
            throw new Error(`Conferência do dependente ${ordem} (${dep.nome}) falhou`);
        }

        if (modo === 'preencher-depois-adicionar') {
            if (!botao) throw new Error('Botão de adicionar dependente não encontrado');
            botao.click();
            await esperar(TEMPO_ESPERA_DEPENDENTE);
            if (ultimoAlerta) {
                registrarLog('aviso', matricula, `Ao adicionar dependente ${ordem}: ${ultimoAlerta}`);
                ultimoAlerta = null;
            }
        }
    }

    // =========================================================================
    // ROBÔ: PROCESSA UMA MATRÍCULA
    // =========================================================================
    let ocupado = false;

    async function processarRegistro(reg, index) {
        let competencia = localStorage.getItem(K_COMPETENCIA) || '';
        let campoCodigo = document.getElementById(ID_CODIGO);
        if (!/^\d{2}\/\d{4}$/.test(competencia)) throw new Error('Informe a competência no formato MM/AAAA');

        // 1. Matrícula
        mostrarAtual(`Digitando matrícula ${reg.matricula}...`);
        preencherCampo(campoCodigo, reg.matricula);
        dispararEnter(campoCodigo);
        await esperar(TEMPO_ESPERA_MATRICULA);
        if (ultimoAlerta) {
            let msg = ultimoAlerta; ultimoAlerta = null;
            throw new Error('Sistema recusou a matrícula: ' + msg);
        }

        // 2. Competência
        let tentativas = 0;
        while (!selecionarCompetencia(ID_COMPETENCIA, competencia)) {
            if (++tentativas >= MAX_TENTATIVAS_COMPETENCIA) throw new Error(`Competência ${competencia} não encontrada`);
            await esperar(TEMPO_LOOP);
        }
        await esperar(TEMPO_ESPERA_CAMPO);

        // 3. Titular
        let campoValor = document.getElementById(ID_VALOR);
        let campoPerc = document.getElementById(ID_PERCENTUAL);
        if (!campoValor || !campoPerc) throw new Error('Campos de valor/percentual do titular não encontrados');

        if (localStorage.getItem(K_PULAR_LANCADOS) !== 'nao' && campoPerc.value.trim() === PERCENTUAL_TITULAR) {
            registrarLog('info', reg.matricula, 'Já possui 67,73% - pulado');
            return 'pulado';
        }

        mostrarAtual(`Mat. ${reg.matricula}: titular R$ ${reg.titular.valor}`);
        preencherCampo(campoValor, reg.titular.valor);
        await esperar(TEMPO_ESPERA_CAMPO);
        preencherCampo(campoPerc, reg.titular.percentual);
        await esperar(TEMPO_ESPERA_CAMPO);

        // 4. Dependentes
        for (let i = 0; i < reg.dependentes.length; i++) {
            if (localStorage.getItem(K_STATUS) !== 'rodando') throw new Error('Interrompido pelo usuário');
            let d = reg.dependentes[i];
            mostrarAtual(`Mat. ${reg.matricula}: dependente ${i + 1}/${reg.dependentes.length} (${d.tipo})`);
            await lancarDependente(d, i + 1, reg.matricula);
        }

        // 5. Conferência final do titular
        if (parseCentavos(campoValor.value) !== parseCentavos(reg.titular.valor) ||
            parseCentavos(campoPerc.value) !== parseCentavos(reg.titular.percentual)) {
            throw new Error(`Conferência do titular falhou (valor "${campoValor.value}", percentual "${campoPerc.value}")`);
        }

        // 6. Salvar
        if (localStorage.getItem(K_AUTO_SALVAR) !== 'sim') {
            registrarLog('info', reg.matricula, 'Preenchido. Aguardando revisão manual e clique em Salvar.');
            return 'revisao';
        }
        let botaoSalvar = document.getElementById(ID_SALVAR);
        if (!botaoSalvar) throw new Error('Botão Salvar não encontrado');
        localStorage.setItem(K_ETAPA, 'salvando:' + index);
        ultimoAlerta = null;
        botaoSalvar.click();
        await esperar(TEMPO_ESPERA_POS_SALVAR);
        if (ultimoAlerta) {
            let msg = ultimoAlerta; ultimoAlerta = null;
            await esperar(TEMPO_ESPERA_POS_POPUP);
            if (/erro|inv[aá]lid|obrigat|n[aã]o foi|falha/i.test(msg)) throw new Error('Sistema retornou: ' + msg);
            registrarLog('ok', reg.matricula, 'Salvo. Sistema: ' + msg);
        } else {
            registrarLog('ok', reg.matricula, `Salvo (titular ${reg.titular.valor} + ${reg.dependentes.length} dep.)`);
        }
        return 'salvo';
    }

    async function cicloRobo() {
        if (ocupado) return;
        if (localStorage.getItem(K_STATUS) !== 'rodando') return;
        if (!document.getElementById(ID_CODIGO)) return;

        let dados = JSON.parse(localStorage.getItem(K_DADOS) || '[]');
        let index = parseInt(localStorage.getItem(K_INDEX) || '0', 10);

        // A página recarregou logo após o Salvar: considera salvo e avança
        let etapa = localStorage.getItem(K_ETAPA) || '';
        if (etapa === 'salvando:' + index) {
            registrarLog('ok', dados[index] ? dados[index].matricula : '-', 'Salvo (tela recarregada após salvar)');
            localStorage.setItem(K_ETAPA, '');
            localStorage.setItem(K_INDEX, String(++index));
        }

        if (index >= dados.length) {
            localStorage.setItem(K_STATUS, 'parado');
            mostrarAtual('Concluído! Todos os registros foram processados.');
            atualizarPainel();
            return;
        }

        ocupado = true;
        let reg = dados[index];
        try {
            let resultado = await processarRegistro(reg, index);
            localStorage.setItem(K_ETAPA, '');
            localStorage.setItem(K_INDEX, String(index + 1));
            if (resultado === 'revisao') localStorage.setItem(K_STATUS, 'parado');
        } catch (e) {
            localStorage.setItem(K_ETAPA, '');
            localStorage.setItem(K_STATUS, 'parado');
            registrarLog('erro', reg.matricula, e.message + ' — robô PAUSADO. Corrija e use ▶ Iniciar (repete) ou Avançar ⏩ (pula).');
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
        let linhas = ['DOC;TAG;TYPE;ID;NAME;VISIVEL;VALOR;TEXTO/OPCOES'];
        documentosAcessiveis().forEach((d, n) => {
            d.querySelectorAll('input, select, textarea, button, a[onclick]').forEach(el => {
                if (el.closest('#painel-ecps')) return;
                let texto = el.tagName === 'SELECT'
                    ? Array.from(el.options).map(o => o.text.trim()).join(' | ')
                    : (el.textContent || el.title || '').trim().slice(0, 60);
                linhas.push([n, el.tagName, el.type || '', el.id, el.name || '', visivel(el) ? 'S' : 'N', (el.value || '').slice(0, 40), texto].join(';'));
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
                <label style="display:block; font-size: 12px; margin-bottom: 10px;"><input type="checkbox" id="ecps-pular"> Pular quem já tem 67,73%</label>

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
                    r.dependentes.map(d => ` + ${d.tipo} R$ ${d.valor}`).join('') + ` = R$ ${r.valorCsv}`;
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

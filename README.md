# IPE

## plano-saude-csv-pdf.user.js

Script Tampermonkey que cruza o CSV da rubrica (ex.: `R963_202509.csv`) com o PDF
"Resumo de Contribuições" do IPE Saúde e lança titular + dependentes na tela
**Pessoal > Cadastros > Servidores > Plano de Saúde** do e-cidade.

1. Instale o script no Tampermonkey e **desative o robô antigo** (v4.0).
2. Abra a tela Plano de Saúde. O painel aparece no canto inferior direito.
3. Informe a competência, selecione o CSV e o PDF e clique em **Cruzar e Validar**.
4. Confira o log e os botões **⬇ CSV gerado** e **⬇ Erros**.
5. Clique em **▶ Iniciar**. Com "Salvar automaticamente" desmarcado, o robô preenche,
   pausa e espera você revisar e clicar em Salvar. Depois, clique em Iniciar de novo.

Regras: titular 67,73% com o valor do PDF. Dependentes com 0%, "filho ou enteado" se
tiverem menos de 18 anos e "cônjuge" se tiverem 18 ou mais. Titular + dependentes do PDF
precisam somar exatamente o valor do CSV, senão a matrícula vai para os erros.

Falhas passageiras não pausam o robô: erro interno do e-cidade (janela com "Uncaught exception"
e botão OK) é repetido até 3 vezes, e valor que não gravou (ex.: tela mostra 0,00 depois de
salvar) até 5 vezes. Se persistir, a matrícula vai para **⬇ Pendências** e o robô segue.

## assentamento-portaria.user.js

Script Tampermonkey (separado do Plano de Saúde) que lê a **foto da portaria** e lança os
assentamentos em **Recursos Humanos > Assentamentos Normais > Inclusão**.

1. Abra a tela de Inclusão de Assentamentos. O painel aparece no canto inferior direito.
2. Selecione a foto e clique em **Ler foto (OCR)** (ou cole o texto da portaria).
3. Confira a tabela **📝 Conferir / editar lançamentos** e corrija o que o OCR leu errado.
4. Clique em **▶ Iniciar**.

Regras: gozo de licença-prêmio → código **35**, com o histórico no modelo padrão e o
protocolo na mesma ordem dos servidores; revogação de portaria → código **REVOG** (REVOGACAO), com a data
da portaria nos dois campos e o texto do artigo como está na folha; outros temas (venda de
licença, IPTU...) são pulados e vão para **⬇ Avisos**. O servidor é pesquisado pelo nome; com
mais de um cadastro, fica o sem data de rescisão e, se ainda houver mais de um, o que condiz
com o período aquisitivo. Se não der para decidir, o robô para e avisa: informe a matrícula
na coluna "Matrícula e-cidade" e clique em Iniciar de novo.

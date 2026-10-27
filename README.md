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

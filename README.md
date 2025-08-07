# Sistema de Resgate de Recompensas - WhatsApp Bot

Sistema integrado que conecta WhatsApp (via Baileys) com Google Sheets para gerenciar resgates de recompensas por funcionários.

## 🚀 Funcionalidades

- **Autenticação WhatsApp**: Conexão automática via QR Code
- **Integração Google Sheets**: Leitura e escrita em tempo real
- **Fluxo de Conversação**: CPF → Visualização de recompensas → Resgate
- **Controle de Concorrência**: Prevenção de operações simultâneas
- **Duplo Registro**: Dados salvos em abas "Historico" e "Lançamentos"
- **Reconexão Automática**: Sistema robusto de reconexão
- **API REST**: Endpoints para monitoramento e recarregamento

## 🛠️ Pré-requisitos

- Node.js (v14+)
- Conta Google Cloud com Google Sheets API habilitada
- Número de WhatsApp para o bot

## 📋 Instalação

1. Clone o repositório:
```bash
git clone <repository-url>
cd ProjetoBarn
```

2. Instale as dependências:
```bash
npm install
```

3. Configure as credenciais:
```bash
cp credentials-example.json credentials.json
# Edite credentials.json com suas credenciais reais
```

4. Execute o bot:
```bash
node bot.js
```

5. Escaneie o QR Code no WhatsApp

## 🔧 Configuração do Google Sheets

### Estrutura das Abas

#### Aba "Funcionarios"
- **ID/CPF**: CPF do funcionário
- **Nome/NOME**: Nome completo
- **Pontos Totais/PONTOS_TOTAIS**: Total de pontos acumulados
- **Saldo/SALDO**: Saldo disponível para resgate

#### Aba "Recompensas"
- **ID**: Código da recompensa
- **Nome/NOME**: Nome da recompensa
- **Valor/VALOR**: Pontos necessários

#### Aba "Historico" (criada automaticamente)
- Data, CPF, Nome, Recompensa, Valor, Pedido, Saldo_Anterior, Saldo_Atual

#### Aba "Lançamentos" (criada automaticamente)
- Data, Hora, CPF, Nome, Tipo, Recompensa, Valor, Pedido, Saldo_Anterior, Saldo_Atual

## 🔒 Segurança

- **Proteção contra Concorrência**: Mutex para operações de saldo
- **Validação Dupla**: Double-check locking pattern
- **Tratamento de Erros**: Logs detalhados e recovery automático
- **Credenciais Seguras**: Arquivo de credenciais no .gitignore

## 📊 API Endpoints

### GET /
Status do sistema e estatísticas
```json
{
  "status": "Ativo",
  "funcionarios": 150,
  "recompensas": 25
}
```

### GET /reload
Recarrega dados do Google Sheets
```json
{
  "success": true
}
```

## 🔄 Fluxo de Conversação

1. **Usuário**: Envia mensagem inicial
2. **Bot**: Solicita CPF
3. **Usuário**: Informa CPF
4. **Bot**: Exibe saldo e recompensas disponíveis
5. **Usuário**: Escolhe código da recompensa
6. **Bot**: Processa resgate e gera nota

## 🏗️ Melhorias Implementadas

### Correções de Bugs
- ✅ Validação de saldo com double-check locking
- ✅ Prevenção de concorrência com mutex
- ✅ Tratamento robusto de erros

### Funcionalidade de Lançamentos
- ✅ Salvamento em aba "Lançamentos" adicional
- ✅ Formato correto do número do pedido (PEDYYYYMMDDHHMMSS)
- ✅ Campos separados para Data e Hora

### Melhorias de Código
- ✅ Uso consistente de `===` para comparações
- ✅ Estrutura organizada e modular
- ✅ Promises e async/await adequados

### Robustez
- ✅ Reconexão automática do WhatsApp
- ✅ Recarregamento periódico de dados com tratamento de erro
- ✅ Logging detalhado para debugging
- ✅ Endpoints API aprimorados

## 📝 Logs

O sistema gera logs detalhados para:
- Conexões/desconexões do WhatsApp
- Operações de resgate
- Erros de processamento
- Recarregamento de dados

## 🚨 Tratamento de Erros

- **Erro de Conexão**: Reconexão automática em 5-10 segundos
- **Erro de Sheets**: Logs detalhados e tentativas de retry
- **Erro de Mensagem**: Resposta amigável ao usuário
- **Concorrência**: Bloqueio automático de operações simultâneas

## 📄 Licença

ISC License
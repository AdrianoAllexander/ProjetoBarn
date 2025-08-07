const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

const CREDENTIALS_PATH = "./credentials.json";

let dadosCache = null;
const conversas = {};

// Mutex para prevenir concorrência nas operações de saldo
const operacoesEmAndamento = new Set();

async function carregarDadosDoSheets() {
  try {
    const creds = require(CREDENTIALS_PATH);

    const serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: creds.private_key.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const doc = new GoogleSpreadsheet(creds.sheetId, serviceAccountAuth);
    await doc.loadInfo();

    const sheetFuncionarios = doc.sheetsByTitle["Funcionarios"];
    if (!sheetFuncionarios)
      throw new Error('Aba "Funcionarios" não encontrada');

    const rowsFunc = await sheetFuncionarios.getRows();
    const funcionarios = {};

    for (const row of rowsFunc) {
      const cpf = row.get("ID") || row.get("CPF");
      if (cpf) {
        funcionarios[cpf] = {
          nome: row.get("Nome") || row.get("NOME") || "",
          pontosTotais: parseInt(
            row.get("Pontos Totais") || row.get("PONTOS_TOTAIS") || "0",
            10
          ),
          saldo: parseInt(row.get("Saldo") || row.get("SALDO") || "0", 10),
          rowIndex: row.rowNumber,
        };
      }
    }

    const sheetRecompensas = doc.sheetsByTitle["Recompensas"];
    if (!sheetRecompensas) throw new Error('Aba "Recompensas" não encontrada');

    const rowsRec = await sheetRecompensas.getRows();
    const recompensas = {};

    for (const row of rowsRec) {
      const id = row.get("ID");
      if (id) {
        recompensas[id] = {
          nome: row.get("Nome") || row.get("NOME") || "",
          valor: parseInt(row.get("Valor") || row.get("VALOR") || "0", 10),
        };
      }
    }

    console.log(`Dados carregados: ${Object.keys(funcionarios).length} funcionários, ${Object.keys(recompensas).length} recompensas`);
    return { funcionarios, recompensas, doc };
  } catch (error) {
    console.error("Erro ao carregar dados do Google Sheets:", error.message);
    throw error;
  }
}

async function atualizarSaldoNoSheets(cpfFuncionario, novoSaldo) {
  try {
    if (!dadosCache.doc)
      throw new Error("Documento do Google Sheets não disponível");
    const sheetFuncionarios = dadosCache.doc.sheetsByTitle["Funcionarios"];
    const rows = await sheetFuncionarios.getRows();

    for (const row of rows) {
      const cpf = row.get("ID") || row.get("CPF");
      if (cpf === cpfFuncionario) {
        row.set("Saldo", novoSaldo);
        await row.save();
        dadosCache.funcionarios[cpfFuncionario].saldo = novoSaldo;
        console.log(`Saldo atualizado para CPF ${cpfFuncionario}: ${novoSaldo}`);
        return;
      }
    }

    throw new Error(`Funcionário com CPF ${cpfFuncionario} não encontrado`);
  } catch (error) {
    console.error("Erro ao atualizar saldo:", error.message);
    throw error;
  }
}

async function salvarResgate(cpfFuncionario, recompensa, numeroPedido) {
  try {
    if (!dadosCache.doc) {
      throw new Error("Documento do Google Sheets não disponível");
    }
    
    // Obter ou criar aba Historico
    let sheetHistorico = dadosCache.doc.sheetsByTitle["Historico"];
    if (!sheetHistorico) {
      sheetHistorico = await dadosCache.doc.addSheet({
        title: "Historico",
        headerValues: [
          "Data",
          "CPF",
          "Nome",
          "Recompensa",
          "Valor",
          "Pedido",
          "Saldo_Anterior",
          "Saldo_Atual",
        ],
      });
    }

    // Obter ou criar aba Lançamentos
    let sheetLancamentos = dadosCache.doc.sheetsByTitle["Lançamentos"];
    if (!sheetLancamentos) {
      sheetLancamentos = await dadosCache.doc.addSheet({
        title: "Lançamentos",
        headerValues: [
          "Data",
          "Hora",
          "CPF",
          "Nome",
          "Tipo",
          "Recompensa",
          "Valor",
          "Pedido",
          "Saldo_Anterior",
          "Saldo_Atual",
        ],
      });
    }

    const agora = new Date();
    const funcionario = dadosCache.funcionarios[cpfFuncionario];

    const registroHistorico = {
      Data: agora.toLocaleString("pt-BR"),
      CPF: cpfFuncionario,
      Nome: funcionario.nome,
      Recompensa: recompensa.nome,
      Valor: recompensa.valor,
      Pedido: numeroPedido,
      Saldo_Anterior: funcionario.saldo + recompensa.valor,
      Saldo_Atual: funcionario.saldo,
    };

    const registroLancamento = {
      Data: agora.toLocaleDateString("pt-BR"),
      Hora: agora.toLocaleTimeString("pt-BR"),
      CPF: cpfFuncionario,
      Nome: funcionario.nome,
      Tipo: "RESGATE",
      Recompensa: recompensa.nome,
      Valor: recompensa.valor,
      Pedido: numeroPedido,
      Saldo_Anterior: funcionario.saldo + recompensa.valor,
      Saldo_Atual: funcionario.saldo,
    };

    // Salvar em ambas as abas
    await Promise.all([
      sheetHistorico.addRow(registroHistorico),
      sheetLancamentos.addRow(registroLancamento)
    ]);

  } catch (error) {
    console.error("Erro ao salvar resgate:", error.message);
    throw error;
  }
}

async function processarMensagem(numeroWhatsApp, mensagem) {
  if (!dadosCache) {
    try {
      dadosCache = await carregarDadosDoSheets();
    } catch (error) {
      console.error("Erro ao carregar dados do sistema:", error.message);
      return "❌ Erro ao carregar dados do sistema. Tente novamente em alguns momentos.";
    }
  }

  const funcionarios = dadosCache.funcionarios;
  const recompensas = dadosCache.recompensas;

  if (!conversas[numeroWhatsApp]) {
    conversas[numeroWhatsApp] = { etapa: "pedindo_cpf" };
    return "🤖 Olá! Digite seu CPF:";
  }

  const etapaAtual = conversas[numeroWhatsApp].etapa;

  if (etapaAtual === "pedindo_cpf") {
    const cpf = mensagem.trim().replace(/\D/g, "");
    if (!funcionarios[cpf]) {
      return `❌ CPF não encontrado. Verifique se digitou corretamente.`;
    }

    conversas[numeroWhatsApp].cpf = cpf;
    conversas[numeroWhatsApp].etapa = "mostrando_pontos";

    const funcionario = funcionarios[cpf];
    const nome = funcionario.nome;
    const pontosTotais = funcionario.pontosTotais;
    const saldo = funcionario.saldo;

    let resposta = `✅ Olá, ${nome}!\n\n📊 Pontos Totais: ${pontosTotais}\n💰 Saldo Disponível: ${saldo}\n\n🎁 RECOMPENSAS DISPONÍVEIS:\n\n`;

    let temRecompensa = false;
    for (const [codigo, recompensa] of Object.entries(recompensas)) {
      if (saldo >= recompensa.valor) {
        resposta += `${codigo} - ${recompensa.nome} (${recompensa.valor}) ✅\n`;
        temRecompensa = true;
      } else {
        resposta += `${codigo} - ${recompensa.nome} (${recompensa.valor}) ❌\n`;
      }
    }

    if (!temRecompensa) {
      delete conversas[numeroWhatsApp];
      return resposta + "\n⚠️ Saldo insuficiente para qualquer recompensa.";
    }

    return resposta + "\n📝 Digite o número da recompensa ou *0* para sair.";
  }

  if (etapaAtual === "mostrando_pontos") {
    const escolha = mensagem.trim();
    if (
      escolha === "0" ||
      escolha.toLowerCase() === "voltar" ||
      escolha.toLowerCase() === "sair"
    ) {
      delete conversas[numeroWhatsApp];
      return "Conversa encerrada.";
    }

    if (!recompensas[escolha]) {
      return "❌ Opção inválida.";
    }

    const cpf = conversas[numeroWhatsApp].cpf;
    const funcionario = funcionarios[cpf];
    const recompensaEscolhida = recompensas[escolha];

    if (funcionario.saldo < recompensaEscolhida.valor) {
      return `❌ Saldo insuficiente para ${recompensaEscolhida.nome}.`;
    }

    // Verificar se já existe uma operação em andamento para este CPF
    if (operacoesEmAndamento.has(cpf)) {
      return "⏳ Aguarde, já existe uma operação em andamento para este CPF.";
    }

    try {
      // Bloquear operações concorrentes para este CPF
      operacoesEmAndamento.add(cpf);

      // Verificar saldo novamente após obter o lock (double-check)
      const funcionarioAtualizado = dadosCache.funcionarios[cpf];
      if (funcionarioAtualizado.saldo < recompensaEscolhida.valor) {
        return `❌ Saldo insuficiente para ${recompensaEscolhida.nome}.`;
      }

      const novoSaldo = funcionarioAtualizado.saldo - recompensaEscolhida.valor;
      await atualizarSaldoNoSheets(cpf, novoSaldo);

      const agora = new Date();
      const numeroPedido = `PED${agora.getFullYear()}${String(
        agora.getMonth() + 1
      ).padStart(2, "0")}${String(agora.getDate()).padStart(2, "0")}${String(
        agora.getHours()
      ).padStart(2, "0")}${String(agora.getMinutes()).padStart(2, "0")}${String(
        agora.getSeconds()
      ).padStart(2, "0")}`;

      await salvarResgate(cpf, recompensaEscolhida, numeroPedido);
      const nota = gerarNotaPedido(
        funcionarioAtualizado.nome,
        cpf,
        recompensaEscolhida,
        numeroPedido,
        novoSaldo
      );
      delete conversas[numeroWhatsApp];
      return nota;
    } catch (error) {
      console.error("Erro ao processar resgate:", error.message);
      return "❌ Erro ao processar resgate. Tente novamente.";
    } finally {
      // Sempre liberar o lock, mesmo em caso de erro
      operacoesEmAndamento.delete(cpf);
    }
  }
}

function gerarNotaPedido(nome, cpf, recompensa, numeroPedido, saldoRestante) {
  const agora = new Date();
  const dataHora = agora.toLocaleString("pt-BR");

  return `
  📋 NOTA DE RESGATE
  
  🆔 Pedido: ${numeroPedido}
  📅 Data: ${dataHora}
  
  👤 Funcionário: ${nome}
  🆔 CPF: ${cpf}
  
  🎁 Recompensa: ${recompensa.nome}
  🎯 Pontos utilizados: ${recompensa.valor}
  💰 Saldo restante: ${saldoRestante}
  
  ✅ Resgate aprovado!
  🏢 Procure o RH para retirar.
  `.trim();
}

async function conectarWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const sock = makeWASocket({ auth: state });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log("QR Code gerado:");
        qrcode.generate(qr, { small: true });
      }
      
      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;
        
        console.log("Conexão fechada, tentando reconectar:", shouldReconnect);
        
        if (shouldReconnect) {
          setTimeout(() => conectarWhatsApp(), 5000);
        }
      } else if (connection === "open") {
        console.log("WhatsApp conectado com sucesso!");
      }
    });

    sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && msg.messageTimestamp && msg.message) {
      let textoMensagem = "";
      if (msg.message.conversation) {
        textoMensagem = msg.message.conversation;
      } else if (msg.message.extendedTextMessage) {
        textoMensagem = msg.message.extendedTextMessage.text;
      }

      if (textoMensagem) {
        const numeroRemetente = msg.key.remoteJid;
        try {
          const respostaBot = await processarMensagem(
            numeroRemetente,
            textoMensagem
          );
          await sock.sendMessage(numeroRemetente, { text: respostaBot });
        } catch (error) {
          console.error("Erro ao processar mensagem:", error.message);
          await sock.sendMessage(numeroRemetente, {
            text: "❌ Erro interno do sistema. Tente novamente em alguns momentos.",
          });
        }
      }
    }
  });
  } catch (error) {
    console.error("Erro ao conectar WhatsApp:", error.message);
    setTimeout(() => conectarWhatsApp(), 10000);
  }
}

const app = express();
app.use(express.json());
const PORT = 3000;

app.get("/", (req, res) => {
  res.json({
    status: "Ativo",
    funcionarios: dadosCache ? Object.keys(dadosCache.funcionarios).length : 0,
    recompensas: dadosCache ? Object.keys(dadosCache.recompensas).length : 0,
  });
});

app.get("/reload", async (req, res) => {
  try {
    dadosCache = await carregarDadosDoSheets();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

carregarDadosDoSheets()
  .then(() => {
    console.log("Sistema iniciado com sucesso!");
    conectarWhatsApp();
  })
  .catch((error) => {
    console.error("Erro ao iniciar sistema:", error.message);
    process.exit(1);
  });

app.listen(PORT, () => {
  console.log(`Servidor Express rodando na porta ${PORT}`);
});

process.on("uncaughtException", (error) => {
  console.error("Exceção não capturada:", error.message);
  setTimeout(() => conectarWhatsApp(), 10000);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Promise rejeitada não tratada:", reason);
  setTimeout(() => conectarWhatsApp(), 10000);
});

setInterval(async () => {
  try {
    console.log("Recarregando dados do Google Sheets...");
    dadosCache = await carregarDadosDoSheets();
    console.log("Dados recarregados com sucesso!");
  } catch (error) {
    console.error("Erro ao recarregar dados:", error.message);
  }
}, 5 * 60 * 1000);

const fs = require("fs");
const path = require("path");

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const {
  inteiroSeguro,
  numeroSeguroBR,
  sanitizarCPF,
  sanitizarNome,
} = require("./utils/limpeza");

const pastaAuth = path.join("/data", "auth_info_baileys");
let dadosCache = null;
const conversas = {};
let lastQrCode = null; 

async function carregarDadosDoSheets() {
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

    const serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: creds.private_key.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const doc = new GoogleSpreadsheet(creds.sheetId, serviceAccountAuth);
    await doc.loadInfo();

    let sheetFuncionarios = doc.sheetsByTitle["Funcionarios"];
    if (!sheetFuncionarios) {
      sheetFuncionarios = await doc.addSheet({
        title: "Funcionarios",
        headerValues: [
          "ID",
          "CPF",
          "Nome",
          "NOME",
          "Pontos Totais",
          "PONTOS_TOTAIS",
          "Saldo",
          "SALDO",
        ],
      });
    }

    let sheetRecompensas = doc.sheetsByTitle["Recompensas"];
    if (!sheetRecompensas) {
      sheetRecompensas = await doc.addSheet({
        title: "Recompensas",
        headerValues: ["ID", "Nome", "NOME", "Valor", "VALOR"],
      });
    }

    let sheetHistorico = doc.sheetsByTitle["Historico"];
    if (!sheetHistorico) {
      sheetHistorico = await doc.addSheet({
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

    const rowsFunc = await sheetFuncionarios.getRows();
    const funcionarios = {};

    for (const row of rowsFunc) {
      const cpf = sanitizarCPF(row.get("ID") || row.get("CPF"));
      if (cpf) {
        funcionarios[cpf] = {
          nome: sanitizarNome(row.get("Nome") || row.get("NOME") || ""),
          pontosTotais: inteiroSeguro(
            row.get("Pontos Totais") || row.get("PONTOS_TOTAIS") || "0"
          ),
          saldo: inteiroSeguro(row.get("Saldo") || row.get("SALDO") || "0"),
          rowIndex: row.rowNumber,
        };
      }
    }

    const rowsRec = await sheetRecompensas.getRows();
    const recompensas = {};

    for (const row of rowsRec) {
      const id = row.get("ID");
      if (id) {
        recompensas[id] = {
          nome: sanitizarNome(row.get("Nome") || row.get("NOME") || ""),
          valor: inteiroSeguro(row.get("Valor") || row.get("VALOR") || "0"),
        };
      }
    }

    return { funcionarios, recompensas, doc };
  } catch (error) {
    console.error("Erro ao carregar dados do Sheets:", error);
    throw error;
  }
}

async function buscarFuncionarioDoSheets(cpfFuncionario) {
  if (!dadosCache || !dadosCache.doc)
    throw new Error("Documento do Google Sheets não disponível");
  const sheetFuncionarios = dadosCache.doc.sheetsByTitle["Funcionarios"];
  const rows = await sheetFuncionarios.getRows();

  for (const row of rows) {
    const cpf = sanitizarCPF(row.get("ID") || row.get("CPF"));
    if (cpf === cpfFuncionario) {
      return {
        nome: sanitizarNome(row.get("Nome") || row.get("NOME") || ""),
        pontosTotais: inteiroSeguro(
          row.get("Pontos Totais") || row.get("PONTOS_TOTAIS") || "0"
        ),
        saldo: inteiroSeguro(row.get("Saldo") || row.get("SALDO") || "0"),
        rowIndex: row.rowNumber,
        rowObj: row,
      };
    }
  }
  return null;
}

async function salvarResgate(cpfFuncionario, recompensa, numeroPedido) {
  try {
    if (!dadosCache.doc) return;
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

    const agora = new Date();
    const funcionario = await buscarFuncionarioDoSheets(cpfFuncionario);

    await sheetHistorico.addRow({
      Data: agora.toLocaleString("pt-BR"),
      CPF: cpfFuncionario,
      Nome: sanitizarNome(funcionario.nome),
      Recompensa: sanitizarNome(recompensa.nome),
      Valor: recompensa.valor,
      Pedido: numeroPedido,
      Saldo_Anterior: funcionario.saldo + recompensa.valor,
      Saldo_Atual: funcionario.saldo,
    });
  } catch (error) {
    console.error("Erro ao salvar resgate:", error);
  }
}

async function processarMensagem(numeroWhatsApp, mensagem) {
  if (!dadosCache) {
    try {
      dadosCache = await carregarDadosDoSheets();
    } catch {
      return "❌ Erro ao carregar dados do sistema.";
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
    const cpf = sanitizarCPF(mensagem.trim());
    if (!funcionarios[cpf]) return `❌ CPF não encontrado.`;

    conversas[numeroWhatsApp].cpf = cpf;
    conversas[numeroWhatsApp].etapa = "mostrando_pontos";

    const funcionario = funcionarios[cpf];
    const nome = sanitizarNome(funcionario.nome);
    const pontosTotais = funcionario.pontosTotais;
    const saldo = funcionario.saldo;

    let resposta = `✅ Olá, ${nome}!\n\n📊 Pontos Totais: ${pontosTotais}\n💰 Saldo Disponível: ${saldo}\n\n🎁 RECOMPENSAS DISPONÍVEIS:\n\n`;

    let temRecompensa = false;
    for (const [codigo, recompensa] of Object.entries(recompensas)) {
      const nomeRec = sanitizarNome(recompensa.nome);
      if (saldo >= recompensa.valor) {
        resposta += `${codigo} - ${nomeRec} (${recompensa.valor}) ✅\n`;
        temRecompensa = true;
      } else {
        resposta += `${codigo} - ${nomeRec} (${recompensa.valor}) ❌\n`;
      }
    }

    if (!temRecompensa) {
      delete conversas[numeroWhatsApp];
      return resposta + "\n⚠️ Saldo insuficiente.";
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
    const recompensaEscolhida = recompensas[escolha];

    try {
      const funcionarioAtual = await buscarFuncionarioDoSheets(cpf);
      if (!funcionarioAtual) {
        return "❌ Funcionário não encontrado.";
      }
      if (funcionarioAtual.saldo < recompensaEscolhida.valor) {
        return `❌ Saldo insuficiente para ${sanitizarNome(
          recompensaEscolhida.nome
        )}.`;
      }

      const novoSaldo = funcionarioAtual.saldo - recompensaEscolhida.valor;
      try {
        funcionarioAtual.rowObj.set("Saldo", novoSaldo);
        await funcionarioAtual.rowObj.save();
      } catch (erroSaldo) {
        console.error("Erro ao atualizar saldo no Sheets:", erroSaldo);
        return "❌ Erro ao atualizar o saldo, tente novamente.";
      }

      dadosCache.funcionarios[cpf].saldo = novoSaldo;

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
        sanitizarNome(funcionarioAtual.nome),
        cpf,
        recompensaEscolhida,
        numeroPedido,
        novoSaldo
      );
      delete conversas[numeroWhatsApp];
      return nota;
    } catch (err) {
      console.error("Erro ao processar resgate:", err);
      return "❌ Erro ao processar resgate.";
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
              
              👤 Funcionário: ${sanitizarNome(nome)}
              🆔 CPF: ${cpf}
              
              🎁 Recompensa: ${sanitizarNome(recompensa.nome)}
              🎯 Pontos utilizados: ${recompensa.valor}
              💰 Saldo restante: ${saldoRestante}
              
              ✅ Resgate aprovado!
              🏢 Procure o RH para retirar.
              `.trim();
}

// --- WhatsApp + QR code ---
async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(pastaAuth);
  const sock = makeWASocket({ auth: state });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // Gera imagem base64 para web
      lastQrCode = await qrcode.toDataURL(qr);
      console.log("QR code gerado! Acesse /qr para visualizar.");
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(() => conectarWhatsApp(), 5000);
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
        } catch (err) {
          console.error("Erro no WhatsApp:", err);
          await sock.sendMessage(numeroRemetente, {
            text: "❌ Erro. Tente novamente.",
          });
        }
      }
    }
  });
}

// --- Express ---
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Rota QR code
app.get("/qr", (req, res) => {
  if (!lastQrCode) {
    return res.send(
      "<h2>QR code não gerado ainda. Aguarde a inicialização do bot!</h2>"
    );
  }
  res.send(`
    <html>
      <body>
        <h2>Escaneie o QR code abaixo com o WhatsApp!</h2>
        <img src="${lastQrCode}" />
      </body>
    </html>
  `);
});

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
  .then(() => conectarWhatsApp())
  .catch((err) => {
    console.error("Erro de inicialização:", err);
    process.exit(1);
  });

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
  process.exit(1);
});
setInterval(async () => {
  try {
    dadosCache = await carregarDadosDoSheets();
  } catch (err) {
    console.error("Erro no reload automático:", err);
  }
}, 5 * 60 * 1000);

// Exporta função para testes
module.exports = { processarMensagem };

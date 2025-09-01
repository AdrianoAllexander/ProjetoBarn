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
  sanitizarEmail,
  sanitizarNome,
  grupoValido,
  tratarGrupo,
  GRUPO_ORDEM,
} = require("./utils/limpeza");

const pastaAuth = path.join("/data", "auth_info_baileys");
let dadosCache = null;
const conversas = {};
let lastQrCode = null;
let botAtivo = false;

function podeResgatar(funcionarioGrupo, recompensaGrupo, recompensaValor) {
  const grupoIndex = GRUPO_ORDEM.indexOf(funcionarioGrupo);
  const recompensaIndex = GRUPO_ORDEM.indexOf(recompensaGrupo);

  if (funcionarioGrupo === "D") return false;
  if (funcionarioGrupo === "AA") {
    return [50, 100, 150, 200].includes(recompensaValor);
  }
  if (funcionarioGrupo === "A") {
    return [50, 100].includes(recompensaValor) && recompensaIndex >= grupoIndex;
  }
  if (funcionarioGrupo === "B") {
    return recompensaValor === 50 && recompensaIndex >= grupoIndex;
  }
  if (funcionarioGrupo === "C") {
    return [15, 30].includes(recompensaValor) && recompensaGrupo === "C";
  }
  return false;
}

async function corrigirCabecalho(sheet, colunaFaltando) {
  await sheet.loadHeaderRow();
  if (!sheet.headerValues.includes(colunaFaltando)) {
    sheet.headerValues.push(colunaFaltando);
    await sheet.setHeaderRow(sheet.headerValues);
  }
}

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
        headerValues: ["ID", "Nome", "Saldo", "Pontos Totais", "Grupo"],
      });
    } else {
      await sheetFuncionarios.loadHeaderRow();
      await corrigirCabecalho(sheetFuncionarios, "Grupo");
      const header = sheetFuncionarios.headerValues;
      const iSaldo = header.indexOf("Saldo");
      const iPontos = header.indexOf("Pontos Totais");
      if (iSaldo !== -1 && iPontos !== -1 && iPontos < iSaldo) {
        header.splice(iPontos, 1);
        header.splice(iSaldo + 1, 0, "Pontos Totais");
        await sheetFuncionarios.setHeaderRow(header);
      }
    }

    let sheetRecompensas = doc.sheetsByTitle["Recompensas"];
    if (!sheetRecompensas) {
      sheetRecompensas = await doc.addSheet({
        title: "Recompensas",
        headerValues: ["ID", "Nome", "Valor", "Grupo"],
      });
    } else {
      await sheetRecompensas.loadHeaderRow();
      await corrigirCabecalho(sheetRecompensas, "Grupo");
    }

    let sheetHistorico = doc.sheetsByTitle["Historico"];
    if (!sheetHistorico) {
      sheetHistorico = await doc.addSheet({
        title: "Historico",
        headerValues: [
          "Data",
          "ID",
          "Nome",
          "Recompensa",
          "Valor",
          "Pedido",
          "Saldo_Anterior",
          "Saldo_Atual",
          "Telefone",
        ],
      });
    } else {
      await sheetHistorico.loadHeaderRow();
      await corrigirCabecalho(sheetHistorico, "Telefone");
    }

    const rowsFunc = await sheetFuncionarios.getRows();
    const funcionarios = {};

    for (const row of rowsFunc) {
      const id = sanitizarEmail(row.get("ID"));
      if (id) {
        let grupoRaw = row.get("Grupo");
        let grupo = tratarGrupo(grupoRaw, "funcionario");
        if (grupoRaw !== grupo) {
          row.set("Grupo", grupo);
          await row.save();
        }
        funcionarios[id] = {
          nome: sanitizarNome(row.get("Nome") || ""),
          pontosTotais: inteiroSeguro(row.get("Pontos Totais") || "0"),
          saldo: inteiroSeguro(row.get("Saldo") || "0"),
          grupo,
          rowIndex: row.rowNumber,
          rowObj: row,
        };
      }
    }

    const rowsRec = await sheetRecompensas.getRows();
    const recompensas = {};

    for (const row of rowsRec) {
      const id = row.get("ID");
      if (id) {
        let grupoRaw = row.get("Grupo");
        let grupo = tratarGrupo(grupoRaw, "recompensa");
        if (grupoRaw !== grupo) {
          row.set("Grupo", grupo);
          await row.save();
        }
        recompensas[id] = {
          nome: sanitizarNome(row.get("Nome") || ""),
          valor: inteiroSeguro(row.get("Valor") || "0"),
          grupo,
        };
      }
    }

    return { funcionarios, recompensas, doc };
  } catch (error) {
    console.error("Erro ao carregar dados do Sheets:", error);
    throw error;
  }
}

async function buscarFuncionarioDoSheets(idFuncionario) {
  if (!dadosCache || !dadosCache.doc)
    throw new Error("Documento do Google Sheets não disponível");
  const sheetFuncionarios = dadosCache.doc.sheetsByTitle["Funcionarios"];
  await sheetFuncionarios.loadHeaderRow();
  const rows = await sheetFuncionarios.getRows();

  for (const row of rows) {
    const id = sanitizarEmail(row.get("ID"));
    if (id === idFuncionario) {
      let grupoRaw = row.get("Grupo");
      let grupo = tratarGrupo(grupoRaw, "funcionario");
      if (grupoRaw !== grupo) {
        row.set("Grupo", grupo);
        await row.save();
      }
      return {
        nome: sanitizarNome(row.get("Nome") || ""),
        pontosTotais: inteiroSeguro(row.get("Pontos Totais") || "0"),
        saldo: inteiroSeguro(row.get("Saldo") || "0"),
        grupo,
        rowIndex: row.rowNumber,
        rowObj: row,
      };
    }
  }
  return null;
}

async function salvarResgate(
  idFuncionario,
  recompensa,
  numeroPedido,
  telefone
) {
  try {
    if (!dadosCache.doc) return;
    let sheetHistorico = dadosCache.doc.sheetsByTitle["Historico"];
    await sheetHistorico.loadHeaderRow();

    const agora = new Date();
    const funcionario = await buscarFuncionarioDoSheets(idFuncionario);

    await sheetHistorico.addRow({
      Data: agora.toLocaleString("pt-BR"),
      ID: idFuncionario,
      Nome: sanitizarNome(funcionario.nome),
      Recompensa: sanitizarNome(recompensa.nome),
      Valor: recompensa.valor,
      Pedido: numeroPedido,
      Saldo_Anterior: funcionario.saldo + recompensa.valor,
      Saldo_Atual: funcionario.saldo,
      Telefone: telefone,
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
    conversas[numeroWhatsApp] = { etapa: "pedindo_id" };
    return "🤖 Olá! Digite seu email:";
  }

  const etapaAtual = conversas[numeroWhatsApp].etapa;

  if (etapaAtual === "pedindo_id") {
    const id = sanitizarEmail(mensagem.trim());
    if (!funcionarios[id]) return `❌ Email não encontrado.`;

    conversas[numeroWhatsApp].id = id;
    conversas[numeroWhatsApp].etapa = "mostrando_pontos";

    const funcionario = funcionarios[id];
    const nome = sanitizarNome(funcionario.nome);
    const saldo = funcionario.saldo;
    const grupo = funcionario.grupo;

    let resposta = `✅ Olá, ${nome}!\n\n💰 Saldo Disponível: ${saldo}\n🔰 Grupo: ${grupo}\n\n🎁 RECOMPENSAS DISPONÍVEIS:\n\n`;

    let temRecompensa = false;
    for (const [codigo, recompensa] of Object.entries(recompensas)) {
      const nomeRec = sanitizarNome(recompensa.nome);
      const pode = podeResgatar(grupo, recompensa.grupo, recompensa.valor);
      if (saldo >= recompensa.valor && pode) {
        resposta += `${codigo} - ${nomeRec} (${recompensa.valor}) ✅\n`;
        temRecompensa = true;
      } else {
        resposta += `${codigo} - ${nomeRec} (${recompensa.valor}) ❌\n`;
      }
    }

    if (!temRecompensa) {
      delete conversas[numeroWhatsApp];
      return resposta + "\n⚠️ Saldo insuficiente ou grupo sem permissão.";
    }

    resposta += "\n📝 Digite o número da recompensa para resgatar.";
    resposta += "\n🔙 Para voltar ou sair, digite '0', 'voltar' ou 'sair'.";

    return resposta;
  }

  if (etapaAtual === "mostrando_pontos") {
    const escolha = mensagem.trim();
    if (
      escolha === "0" ||
      escolha.toLowerCase() === "voltar" ||
      escolha.toLowerCase() === "sair"
    ) {
      delete conversas[numeroWhatsApp];
      return "Conversa encerrada. Você pode iniciar novamente digitando seu email.";
    }

    if (!recompensas[escolha]) {
      return "❌ Opção inválida. Digite o número da recompensa, ou '0', 'voltar' ou 'sair' para encerrar.";
    }

    const id = conversas[numeroWhatsApp].id;
    const recompensaEscolhida = recompensas[escolha];
    const funcionarioAtual = await buscarFuncionarioDoSheets(id);

    if (!funcionarioAtual) return "❌ Funcionário não encontrado.";

    if (
      !podeResgatar(
        funcionarioAtual.grupo,
        recompensaEscolhida.grupo,
        recompensaEscolhida.valor
      )
    ) {
      return `❌ Sua categoria de grupo (${
        funcionarioAtual.grupo
      }) não pode resgatar essa recompensa (${sanitizarNome(
        recompensaEscolhida.nome
      )}, R$${recompensaEscolhida.valor}, grupo ${recompensaEscolhida.grupo}).`;
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

    dadosCache.funcionarios[id].saldo = novoSaldo;

    const agora = new Date();
    const numeroPedido = `PED${agora.getFullYear()}${String(
      agora.getMonth() + 1
    ).padStart(2, "0")}${String(agora.getDate()).padStart(2, "0")}${String(
      agora.getHours()
    ).padStart(2, "0")}${String(agora.getMinutes()).padStart(2, "0")}${String(
      agora.getSeconds()
    ).padStart(2, "0")}`;

    await salvarResgate(id, recompensaEscolhida, numeroPedido, numeroWhatsApp);
    const nota = gerarNotaPedido(
      sanitizarNome(funcionarioAtual.nome),
      id,
      recompensaEscolhida,
      numeroPedido,
      novoSaldo
    );
    delete conversas[numeroWhatsApp];
    return nota;
  }
}

function gerarNotaPedido(nome, id, recompensa, numeroPedido, saldoRestante) {
  const agora = new Date();
  const dataHora = agora.toLocaleString("pt-BR");

  return `
              📋 NOTA DE RESGATE
              
              🆔 Pedido: ${numeroPedido}
              📅 Data: ${dataHora}
              
              👤 Funcionário: ${sanitizarNome(nome)}
              📧 Email: ${id}
              
              🎁 Recompensa: ${sanitizarNome(recompensa.nome)}
              💰 Saldo restante: ${saldoRestante}
              
              ✅ Resgate aprovado!
              🏢 Procure o RH para retirar.
              `.trim();
}

async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(pastaAuth);
  const sock = makeWASocket({ auth: state });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      lastQrCode = await qrcode.toDataURL(qr);
      console.log("QR code gerado! Acesse /qr para visualizar.");
    }
    if (connection === "open") {
      botAtivo = true;
    }
    if (connection === "close") {
      botAtivo = false;
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

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

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
    status: botAtivo ? "Ativo" : "Inativo",
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
  .then((dados) => {
    dadosCache = dados;
    conectarWhatsApp();
  })
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
}, 1 * 60 * 1000);

module.exports = { processarMensagem };
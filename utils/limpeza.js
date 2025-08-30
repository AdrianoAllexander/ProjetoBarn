const GRUPO_ORDEM = ["AA", "A", "B", "C", "D"];

function inteiroSeguro(valor) {
  if (!valor) return 0;
  const limpo = String(valor).replace(/[^\d-]/g, "");
  const convertido = parseInt(limpo, 10);
  return isNaN(convertido) ? 0 : convertido;
}

function numeroSeguroBR(valor) {
  if (!valor) return 0;
  const limpo = String(valor)
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  const convertido = parseFloat(limpo);
  return isNaN(convertido) ? 0 : convertido;
}

function sanitizarCPF(valor) {
  return (valor || "").replace(/\D/g, "");
}

function sanitizarNome(valor, tamanhoMax = 60) {
  if (!valor) return "";
  return String(valor)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^\p{L}\p{N} .,'-]/gu, "")
    .trim()
    .slice(0, tamanhoMax);
}

function grupoValido(valor) {
  return GRUPO_ORDEM.includes((valor || "").trim().toUpperCase());
}

function tratarGrupo(valor, tipo = "funcionario") {
  const v = (valor || "").toString().trim().toUpperCase();
  if (grupoValido(v)) return v;
  const vCorrigido = v.replace(/[^A-Z]/g, "");
  if (grupoValido(vCorrigido)) return vCorrigido;
  return tipo === "funcionario" ? "D" : "C";
}

module.exports = {
  inteiroSeguro,
  numeroSeguroBR,
  sanitizarCPF,
  sanitizarNome,
  grupoValido,
  tratarGrupo,
  GRUPO_ORDEM,
};
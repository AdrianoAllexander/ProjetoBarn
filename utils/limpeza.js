function inteiroSeguro(valor) {
    if (!valor) return 0;
    const limpo = String(valor).replace(/[^\d-]/g, "");
    const convertido = parseInt(limpo, 10);
    return isNaN(convertido) ? 0 : convertido;
  }
  

  function numeroSeguroBR(valor) {
    if (!valor) return 0;
    const limpo = String(valor).replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
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
  
  module.exports = {
    inteiroSeguro,
    numeroSeguroBR,
    sanitizarCPF,
    sanitizarNome,
  };
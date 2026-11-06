/* Identidad compartida por el lector y el panel. Las notas anteriores conservan
   su enlace al editarlas; las nuevas reciben un UUID al guardarse. */
const PulsoNotas = Object.freeze({
  clave(nota){ return String(nota.id || 'titulo-' + nota.tit); },
  enlace(nota, base){
    const url = new URL(base);
    url.search = '';
    url.hash = '';
    url.searchParams.set('nota', this.clave(nota));
    return url.href;
  }
});

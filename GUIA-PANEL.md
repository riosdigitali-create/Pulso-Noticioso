# Guía del Panel — Pulso Noticioso

Para el día a día. Si lo que buscas es poner el sitio en internet por primera vez, eso está en **GUIA-DESPLIEGUE.md**.

---

## 1. Entrar

Abre `tusitio.com/admin.html`, o pulsa **"Panel"** al pie del sitio.

Contraseña: **`237123`**

Marca **"Recordar en este equipo"** si es tu ordenador y no quieres escribirla cada vez.

### Las dos pastillas

Arriba a la derecha aparece una de estas dos, y la diferencia lo es todo:

- 🟢 **Publicación activa** — todo normal, puedes publicar.
- 🟠 **Vista previa** — no hay servidor detrás. Puedes probarlo todo, pero **nada se publica**. Sale si abres el archivo con doble clic en lugar de por su dirección web, o si Cloudflare aún no ha desplegado la función.

---

## 2. Cómo funciona ahora

Esto cambió por completo respecto a la versión anterior. Ya **no** hay que descargar el sitio ni subirlo a mano a ningún sitio.

```
Editas  →  se guarda como borrador en tu navegador
        →  pulsas PUBLICAR
        →  se hace un commit en GitHub
        →  el sitio se actualiza solo en 30-60 segundos
```

La barra de arriba te dice siempre en cuál de los dos estados estás:

- ✓ *Todo publicado. No hay cambios pendientes.*
- ● *Tienes cambios sin publicar.* ← el público todavía no los ve

**Descartar cambios** tira el borrador y vuelve a lo que hay publicado ahora mismo.

> El borrador vive solo en el navegador que estés usando. Si cambias de equipo, se queda atrás. Solo lo publicado es permanente.

---

## 3. Publicar una nota

1. Elige la sección en el desplegable de arriba.
2. **＋ Agregar nota**.
3. Rellena:
   - **Etiqueta** — el texto rojo de la tarjeta (ej. "Última hora").
   - **Arte de portada** — el fondo ilustrado que se usa si la nota no lleva foto.
   - **Foto de la biblioteca** — elige una de las que ya subiste.
   - **…o URL externa** — si la foto está en otro sitio.
   - **Título** — obligatorio.
   - **Resumen** — el texto corto de la tarjeta.
   - **Cuerpo** — el texto completo. **Separa cada párrafo con una línea vacía.**
   - **Firma / fecha** — ej. `Redacción · 17 de julio`.
4. **💾 Guardar nota** → va al borrador.
5. **🚀 Publicar** → sale al aire.

En cada nota de la lista: ✏️ editar · ▲▼ reordenar · ⭐ (solo en laterales) intercambiar con la destacada · 🗑️ eliminar.

---

## 4. Subir fotos

Sección **🖼️ Biblioteca de imágenes**.

1. Elige la **sección** a la que pertenece la foto.
2. Escribe un **título base** (opcional, pero recomendable).
3. Arrastra las fotos a la zona punteada, o haz clic para elegirlas.

Se renombran solas siguiendo la convención:

```
contenido/imagenes/nacional--reforma-electoral--m3k9x2.jpg
                   ↑         ↑                  ↑
                   sección   título             id único
```

Ese nombre no es decorativo: **el nombre del archivo es el dato**. Si algún día el JSON de contenido se perdiera, el panel reconstruye las notas leyendo solo estos nombres.

Límites: jpg, png, webp o gif · máximo 5 MB cada una.

Las fotos se suben al repositorio **al instante**, sin esperar a Publicar. Borrarlas también es inmediato.

---

## 5. Nota destacada

Tiene dos modos:

- 🔴 **Automático** — se llena sola con la última hora del RSS. Es lo que está puesto ahora.
- ✍️ **Manual** — tu propia nota, fija.

En cuanto escribes y guardas una destacada a mano, el modo automático se apaga solo.

---

## 6. Ticker

Un mensaje por línea.

> Si en Ajustes tienes activados los titulares en vivo, solo se muestra **tu primera línea** y el resto son titulares reales del RSS.

---

## 7. Ajustes

- **Noticias en vivo** — activadas/desactivadas. Si las apagas, solo se ve tu contenido.
- **Fuente RSS principal** — ahora: `https://vanguardia.com.mx/rss.xml`
- **Región para noticias locales** — ahora: `Saltillo Coahuila`
- **📻 URL del stream de radio** — **está vacía**. Hasta que la pongas, el botón de play no hace nada.
- **▶️ ID del canal de YouTube** — ya configurado. Por eso "En vivo" y "Últimos videos" funcionan solos.
- **Listas de reproducción** — una por línea: `Nombre | ID`. Si lo dejas vacío, la pestaña se oculta.
- **Redes** — Facebook, Instagram, los dos YouTube.

La contraseña **no se cambia aquí**. Vive cifrada en Cloudflare (`ADMIN_PASSWORD`). Ver GUIA-DESPLIEGUE.md § 8.

---

## 8. Si algo sale mal

**Publiqué y no se ve.** Espera 60 segundos y recarga con Ctrl+F5. Si sigue igual, mira en GitHub → Commits: si el commit está ahí, es solo caché.

**Me equivoqué y ya publiqué.** Nada se pierde nunca: cada publicación es un commit. Ve al repo → Commits → busca el anterior → **Revert**. En 30-60 s vuelve solo.

**Dice "Modo vista previa" y debería publicar.** Comprueba que entraste por la dirección web real y no abriendo el archivo. Si es la web, ve a GUIA-DESPLIEGUE.md § 11.

---

## 9. Lo que ya no existe

Si venías de la versión anterior:

| Antes | Ahora |
|---|---|
| Dos usuarios (`direccion` y `admin`) | Uno solo |
| Contraseña dentro del HTML | Variable cifrada en Cloudflare |
| "Descargar sitio actualizado" + subir a mano | Botón **Publicar** |
| Exportar / Importar JSON | El historial de Git |
| Ctrl+Alt+A | `admin.html` |

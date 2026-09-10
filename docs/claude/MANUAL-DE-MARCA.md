# Manual de marca — Nova Express (10/09/2026, v1.1)

PDF entregado a Felipe: `Nova-Express-Manual-de-marca-v1.1.pdf` (12 páginas, A4 apaisado). Es para el
de marketing; el sistema no lo usa.

**v1.1 (mismo día):** correcciones de una diseñadora que revisó el PDF con anotaciones. Lo que
cambió: portada con el anillo grande en dos tonos de azul y el título más chico; se llama
"mundo" al anillo del logo; "área de resguardo" (no "respiro") con una grilla de líneas
detrás del logo y cotas x; "Usos prohibidos"; colores con el uso escrito debajo de cada
muestra; sin la sección "cuando no se puede instalar la fuente"; **el isotipo ya no lleva el
disco blanco entre el globo y el anillo** (sobre azul: anillo naranja + swoosh y globo
blancos); aplicaciones nuevas: logo sobre foto color, sobre foto blanco y negro, foto con velo
azul + texto (fotos de muestra, las reemplaza marketing); sin el "resumen en cinco líneas";
slide final de cierre con el logo.

## Lo que define

- **Colores oficiales:** azul Nova `#2A3661` (RGB 42·54·97) y naranja Nova `#EA6749` (RGB
  234·103·73). Apoyo: gris globo `#BFC1C4`, azul hielo `#EAF1F8`, gris texto `#1F2937`, blanco.
  Los viejos violeta `#403754` / coral `#ED6D51` ya no se usan. Proporción 60 blanco / 30 azul /
  10 naranja; el naranja es acento, no fondo.
- **Logo principal:** wordmark NOVA + express con el anillo partido en la O. Versiones: a color
  sobre blanco (principal), sobre azul (letras blancas, anillo naranja), monocromo azul, negativo.
- **Isotipo:** anillo partido (naranja arriba, azul abajo) + globo gris sobre disco blanco. Para
  perfiles, favicon, sellos. Versiones: color, sobre azul (globo azul), monocromo, negativo.
- **Respiro:** la altura de la O (x) alrededor; en el isotipo, un cuarto del diámetro.
  **Mínimos:** logo 30 mm / 120 px; isotipo 8 mm / 32 px.
- **Tipografía:** DM Sans (títulos 800/700, texto 400/500), DM Mono solo para números
  alineados (precios, kg, guías). Sin la fuente: Arial. Es lo mismo que usa el cuadro de
  cotización del sistema.
- **Aplicaciones:** foto de perfil (isotipo centrado), post de Instagram (fondo azul, título
  blanco con una palabra naranja), firma de mail (isotipo + nombre + dos líneas grises),
  documentos (logo arriba a la izquierda, total en naranja).

## Archivos de marca

`nova-logo-final.svg`, `nova-logo-sin-fondo-2400px.png`, `nova-logo-final-fondo-blanco.png`,
`nova-isotipo.svg`, `nova-isotipo-sin-fondo-2400px.png`, `nova-perfil-1080.png`,
`nova-perfil-fondo-azul-1080.png`. En el repo: `frontend/assets/logos/nova.svg` y `nova.png`
(logo principal). El isotipo todavía no está en el repo (favicon pendiente si Felipe quiere).

## Cómo se hizo

HTML + CSS (DM Sans/DM Mono embebidas en base64 desde `@fontsource`) → PDF con Chromium
(`/tmp/manual/build2.py` + `style.css` + `style2.css`, `topdf.js`; `build.py` es la v1.0). Los logos van como SVG inline con clases
`.azul/.naranja/.gris/.blanco` para recolorear cada versión. Los CMYK son conversión
aritmética, no Pantone: para imprenta importante pedir prueba de color.

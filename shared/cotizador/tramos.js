/* Tramos de peso de la matriz de profit: UNA sola fuente para el backend
   (profit.service.js) y la pantalla del cliente (clientes-perfil.js). Antes estaban
   duplicados a mano en los dos lados (15/10/2026).

   TRAMOS_POR_DEFECTO: el juego que hereda el cliente sin tramos propios. Son los cortes con
   los que se cargaron los datos (0-5, 5-10, …, 30-40, 40-50, +50); cambiarlos cambia
   precios ya cargados, así que NO se tocan: los tramos finos llegan por `cliente_tramos`
   (scripts/migrar-tramos.js), cliente por cliente.
   TRAMOS_SUGERIDOS: los de 5 en 5 hasta 50 que pidió Felipe el 12/08/2026. Son los que
   ofrece la pantalla del cliente y la base de la migración; no se aplican solos. */
(function (raiz) {
  const TRAMOS_POR_DEFECTO = [
    { min: 0, max: 5 },
    { min: 5, max: 10 },
    { min: 10, max: 15 },
    { min: 15, max: 20 },
    { min: 20, max: 25 },
    { min: 25, max: 30 },
    { min: 30, max: 40 },
    { min: 40, max: 50 },
    { min: 50, max: null },
  ];
  const TRAMOS_SUGERIDOS = [
    { min: 0, max: 5 },
    { min: 5, max: 10 },
    { min: 10, max: 15 },
    { min: 15, max: 20 },
    { min: 20, max: 25 },
    { min: 25, max: 30 },
    { min: 30, max: 35 },
    { min: 35, max: 40 },
    { min: 40, max: 45 },
    { min: 45, max: 50 },
    { min: 50, max: null },
  ];
  const api = { TRAMOS_POR_DEFECTO, TRAMOS_SUGERIDOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.NovaTramos = api;
}(typeof window !== 'undefined' ? window : this));

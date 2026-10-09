/**
 * Apps Script para exponer la cola de clientes al userscript de Tampermonkey.
 *
 * Setup:
 * 1. Crea una Google Sheet con una pestaña llamada "Clientes".
 * 2. Encabezados en la fila 1 (exactamente):
 *      cedula | ciudadTramite
 * 3. Una fila por cliente. Ejemplos de ciudadTramite:
 *      - Un solo trámite:
 *          Bogotá - Solicitud de devolución y/o compensación Vehículos eléctricos o Híbridos persona natural
 *      - Varias preferencias (prioridad de izquierda a derecha), separadas por | :
 *          Medellín - ... Vehículos eléctricos ... | Medellín - ... persona natural
 *      - O un JSON:
 *          ["opción preferida","opción de respaldo"]
 * 4. Extensiones > Apps Script, pega este archivo, guarda.
 * 5. Implementar > Nueva implementación > Aplicación web:
 *      - Ejecutar como: Yo
 *      - Quién tiene acceso: Cualquiera
 * 6. Copia la URL que termina en /exec y pégala en CONFIG.sheet.url del userscript.
 *
 * scheduled y cita NO van en la Sheet: los lleva el navegador en localStorage.
 */

function doGet() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Clientes');
  if (!hoja) {
    return json_({ error: 'No existe la hoja "Clientes"', clientes: [] });
  }

  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) {
    return json_({ clientes: [] });
  }

  const headers = valores[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  const iCedula = headers.indexOf('cedula');
  const iTramite = headers.indexOf('ciudadtramite');

  if (iCedula < 0 || iTramite < 0) {
    return json_({
      error: 'Faltan columnas cedula y/o ciudadTramite en la fila 1',
      clientes: [],
    });
  }

  const clientes = [];
  for (var r = 1; r < valores.length; r++) {
    var fila = valores[r];
    var cedula = fila[iCedula];
    var ciudadTramite = fila[iTramite];
    if (cedula === '' || cedula == null) continue;
    if (ciudadTramite === '' || ciudadTramite == null) continue;

    clientes.push({
      cedula: String(cedula).replace(/\D/g, '') || cedula,
      ciudadTramite: String(ciudadTramite).trim(),
    });
  }

  return json_({ clientes: clientes });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

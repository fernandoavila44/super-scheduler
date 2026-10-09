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

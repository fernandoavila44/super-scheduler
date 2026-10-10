function doGet(e) {
  e = e || { parameter: {} };
  if (e.parameter && e.parameter.action === 'schedule') {
    return schedule_(e.parameter);
  }
  return listar_();
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'JSON inválido' });
  }
  return schedule_(body);
}

function listar_() {
  var ctx = hojaConIndices_();
  if (ctx.error) return json_({ error: ctx.error, clientes: [] });

  var clientes = [];
  for (var r = 1; r < ctx.valores.length; r++) {
    var fila = ctx.valores[r];
    var cedula = fila[ctx.iCedula];
    var ciudadTramite = fila[ctx.iTramite];
    if (cedula === '' || cedula == null) continue;
    if (ciudadTramite === '' || ciudadTramite == null) continue;

    var scheduled = ctx.iScheduled >= 0 ? esVerdadero_(fila[ctx.iScheduled]) : false;
    var date = ctx.iDate >= 0 ? textoCelda_(fila[ctx.iDate]) : '';
    var hour = ctx.iHour >= 0 ? textoCelda_(fila[ctx.iHour]) : '';

    clientes.push({
      cedula: String(cedula).replace(/\D/g, '') || String(cedula),
      ciudadTramite: String(ciudadTramite).trim(),
      scheduled: scheduled,
      date: date,
      hour: hour,
    });
  }

  return json_({ clientes: clientes });
}

function schedule_(datos) {
  var cedula = String((datos && datos.cedula) || '').replace(/\D/g, '');
  if (!cedula) return json_({ ok: false, error: 'Falta cedula' });

  var ctx = hojaConIndices_();
  if (ctx.error) return json_({ ok: false, error: ctx.error });
  if (ctx.iScheduled < 0 || ctx.iDate < 0 || ctx.iHour < 0) {
    return json_({
      ok: false,
      error: 'Faltan columnas scheduled, date y/o hour en la fila 1',
    });
  }

  var fila = -1;
  for (var r = 1; r < ctx.valores.length; r++) {
    var celda = String(ctx.valores[r][ctx.iCedula] || '').replace(/\D/g, '');
    if (celda === cedula) {
      fila = r + 1;
      break;
    }
  }
  if (fila < 0) return json_({ ok: false, error: 'No se encontró la cédula ' + cedula });

  var scheduled =
    datos.scheduled === undefined || datos.scheduled === null || datos.scheduled === ''
      ? true
      : esVerdadero_(datos.scheduled);

  ctx.hoja.getRange(fila, ctx.iScheduled + 1).setValue(scheduled);
  ctx.hoja.getRange(fila, ctx.iDate + 1).setValue(textoCelda_(datos.date));
  ctx.hoja.getRange(fila, ctx.iHour + 1).setValue(textoCelda_(datos.hour));

  return json_({
    ok: true,
    cedula: cedula,
    scheduled: scheduled,
    date: textoCelda_(datos.date),
    hour: textoCelda_(datos.hour),
  });
}

function hojaConIndices_() {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Clientes');
  if (!hoja) return { error: 'No existe la hoja "Clientes"' };

  var valores = hoja.getDataRange().getValues();
  if (!valores.length) return { error: 'La hoja "Clientes" está vacía', hoja: hoja, valores: [] };

  var headers = valores[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var iCedula = headers.indexOf('cedula');
  var iTramite = headers.indexOf('ciudadtramite');
  if (iCedula < 0 || iTramite < 0) {
    return { error: 'Faltan columnas cedula y/o ciudadTramite en la fila 1' };
  }

  return {
    hoja: hoja,
    valores: valores,
    iCedula: iCedula,
    iTramite: iTramite,
    iScheduled: headers.indexOf('scheduled'),
    iDate: headers.indexOf('date'),
    iHour: headers.indexOf('hour'),
  };
}

function esVerdadero_(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v === '' || v == null) return false;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'si' || s === 'sí';
}

function textoCelda_(v) {
  if (v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }
  return String(v).trim();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

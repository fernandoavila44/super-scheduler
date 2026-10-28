// ==UserScript==
// @name         Super Scheduler (sandbox)
// @namespace    super-scheduler
// @version      1.29-sandbox
// @description  [SANDBOX] Appointment scheduling monitor
// @match        https://agendamiento.dian.gov.co/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @downloadURL  https://raw.githubusercontent.com/fernandoavila44/super-scheduler/sandbox/scheduler.user.js
// @updateURL    https://raw.githubusercontent.com/fernandoavila44/super-scheduler/sandbox/scheduler.user.js
// ==/UserScript==
//
// sandbox = pruebas. master = oficial.
//

(function () {
    'use strict';

    // ───────────────────────────── CONFIGURACIÓN ─────────────────────────────

    // Respaldo vacío a propósito: no subir cédulas al repo. La cola vive en la Sheet.
    // ciudadTramite: string o arreglo en orden de preferencia.
    const CLIENTES_INICIALES = [];

    const CONFIG = {
        // Página donde arranca el flujo. Recarga completa solo en fallos duros
        // o tras agotar reintentos suaves (sin cupo reutiliza el DOM).
        // Player.aspx redirige a Default.aspx?Error=3; el recurso real es este.
        urlInicio: 'https://agendamiento.dian.gov.co',

        // Sin cupo: cerrar modal y repetir desde Categoría sin recargar.
        // Tras softMaxSeguidos fallos seguidos, o si no se puede volver a
        // Categoría, se recarga la página (estado del player limpio).
        reintento: {
            softMaxSeguidos: 8,
            selCategoria:
                'div.boton.btnCategoria[llave="63071985-f5bd-43fe-beed-38f64c97371b"]',
            selAnterior: 'div[tipo="Control"][nombre="btnAnterior"]',
            intentosAnterior: 6,
        },

        // URL /exec y nombre de pestaña (ciudad) no van en el repo: se guardan en
        // localStorage con el panel. Ver clientes-api.gs.
        sheet: {
            activo: true,
            url: '',
            // Nombre exacto de la pestaña; vacío = se elige en el dropdown del panel.
            hoja: '',
            // Opciones del dropdown (deben coincidir con los nombres de las pestañas).
            ciudades: ['Bogota', 'Medellin', 'Cali', 'Bucaramanga'],
            timeoutMs: 15000,
            // La lista guardada se usa sin consultar la Sheet si tiene menos de
            // esto; si es más vieja, se refresca en segundo plano sin frenar el ciclo.
            refrescoSegundos: 60,
            // Más vieja que esto ya no se usa: el ciclo espera a la Sheet, para no
            // reintentar a alguien que otro PC agendó mientras tanto.
            edadMaximaCacheSegundos: 300,
            // Un agendado local más reciente que esto no se revierte aunque la
            // Sheet todavía no lo refleje (su escritura puede ir en camino).
            proteccionAgendadoMs: 10 * 60 * 1000,
        },

        // Tiempo entre ciclos cuando no hay cupo (o tras un fallo recuperable).
        // El valor activo se elige en el dropdown del panel y se guarda en localStorage.
        intervaloSegundos: 30,
        intervalosSegundos: [5, 15, 30, 45, 60],

        // Tras agendar, si quedan clientes, espera esto y vuelve a empezar.
        segundosAntesDelSiguienteCliente: 0,

        // Margen alto: el sitio a veces tarda en pintar controles.
        timeoutElementoMs: 45000,

        // Margen mínimo tras un paso si no define "espera" (la sincronía real
        // la hace esperaHasta / esperarSinCarga, no este número).
        pausaEntrePasosMs: 300,

        // Tras un clic, si el siguiente control ya está listo, igual se deja
        // respirar al player (transiciones ~0.75s a veces).
        esperaTrasClicMs: 200,

        // Splash / capa de carga del WebPlayer: no avanzar mientras estén visibles.
        cargando: {
            sels: ['#mpcWPdivCargando', '.splash', '#divSplash'],
            timeoutMs: 15000,
        },

        // Pasos en el orden exacto en que se ejecutan.
        // Formas admitidas:
        //   { sel: '#boton',            desc: 'Iniciar' }                        -> clic
        //   { sel: '.btn', contiene: 'Continuar', desc: 'Continuar' }            -> clic al que tenga ese texto
        //   { sel: '#tipoDoc', valor: '1', desc: 'Tipo de documento' }           -> <select> por value
        //   { sel: '#sedes', opcionContiene: 'Bogota' }                          -> abre el <select> y elige por texto
        //   { sel: '#horas', primeraOpcion: true }                               -> abre el <select> y elige la primera con valor
        //   { sel: '#numDoc', texto: '1234567890', desc: 'Documento' }           -> <input>
        //   { accion: 'fechaYHora' }                                             -> calendario + horas con reintento
        //   { accion: 'tramite' }                                                -> trámite según la cola de clientes
        // Cada paso acepta: espera (ms), esperaHasta (sel o "a, b"), omitirSiMarcado,
        // opcional: true (si falta, no aborta).
        pasos: [
            {
                sel: 'div[nombrecontrol="btnSolicitarCita"]',
                desc: 'Solicitar cita',
                esperaHasta: 'div.boton.btnTipoPersona[llave="1"]',
                espera: 200,
            },
            {
                sel: 'div.boton.btnTipoPersona[llave="1"]',
                desc: 'Tipo de persona',
                esperaHasta: 'div.boton.btnTipoAtencion[llave="2"]',
                espera: 200,
            },
            {
                sel: 'div.boton.btnTipoAtencion[llave="2"]',
                desc: 'Tipo de atención',
                esperaHasta:
                    'div.boton.btnCategoria[llave="63071985-f5bd-43fe-beed-38f64c97371b"]',
                espera: 200,
            },
            {
                sel: 'div.boton.btnCategoria[llave="63071985-f5bd-43fe-beed-38f64c97371b"]',
                desc: 'Categoría del trámite',
                // Servicios OK, o ModalError si no hay cupo (no esperar 45 s al select).
                esperaHasta:
                    'div[nombrecontrol="Servicios"] select.customSelect, div[tipo="Control"][pantalla="ModalError"][nombre="btnAceptar"]',
                espera: 200,
            },
            { accion: 'sinEspecialidades', desc: '¿Hay especialidades?' },
            // Abre el trámite y elige al primer cliente pendiente cuya ciudad
            // aparezca entre las opciones. Si no aparece, prueba con el siguiente.
            {
                accion: 'tramite',
                desc: 'Trámite del cliente',
                esperaHasta:
                    'div[tipo="Control"][pantalla="PasoUno"][nombre="btnSiguiente"]',
                espera: 200,
            },
            // Hay un btnSiguiente por paso, más una variante btnSiguienteBlock que es
            // la deshabilitada. Se apunta al del PasoUno y solo al habilitado.
            {
                sel: 'div[tipo="Control"][pantalla="PasoUno"][nombre="btnSiguiente"]',
                desc: 'Siguiente (paso uno)',
                esperaHasta:
                    'div[tipo="Control"][pantalla="PasoDos"][nombre="btnFecha"]',
                espera: 200,
            },
            // La fecha y la hora van juntas porque las horas dependen del día: si un
            // día no tiene horas libres hay que volver al calendario y probar otro.
            {
                accion: 'fechaYHora',
                desc: 'Fecha y hora',
                esperaHasta:
                    'div[tipo="Control"][pantalla="PasoDos"][nombre="btnSiguiente"]',
                espera: 200,
            },
            {
                sel: 'div[tipo="Control"][pantalla="PasoDos"][nombre="btnSiguiente"]',
                desc: 'Siguiente (paso dos)',
                // No esperar #g-recaptcha-response aquí: va display:none y bloqueaba
                // el paso del captcha (alarma / título CUPOS / AHK) hasta 45 s o más.
                espera: 300,
            },
            // La alarma y CUPOS ya salieron al elegir fecha y hora.
            { accion: 'captcha', desc: 'Captcha (manual)' },
            // El campo del documento solo se muestra con el captcha resuelto, y la
            // consulta se dispara al salir del campo. La sincronía es esperaHasta.
            {
                accion: 'documento',
                desc: 'Número de documento',
                esperaHasta:
                    'div[nombrecontrol="DatosCorretos"] input[type="radio"][value="1"], div[nombrecontrol="TerminosCondiciones"] input[type="checkbox"]',
                espera: 200,
            },
            {
                sel: 'div[nombrecontrol="DatosCorretos"] input[type="radio"][value="1"]',
                marcar: true,
                omitirSiMarcado: true,
                desc: 'Datos correctos: Sí',
                esperaHasta:
                    'div[nombrecontrol="TerminosCondiciones"] input[type="checkbox"]',
                espera: 150,
            },
            {
                sel: 'div[nombrecontrol="TerminosCondiciones"] input[type="checkbox"]',
                marcar: true,
                omitirSiMarcado: true,
                desc: 'Aceptar tratamiento de datos',
                esperaHasta:
                    'div[tipo="Control"][pantalla="PasoTres"][nombre="btnSiguiente"]',
                espera: 150,
            },
            {
                sel: 'div[tipo="Control"][pantalla="PasoTres"][nombre="btnSiguiente"]',
                desc: 'Siguiente (paso tres)',
                esperaHasta:
                    'div[tipo="Control"][pantalla="PasoCuatro"][nombre="btnAgendarCita"]',
                espera: 200,
            },
            // Clic en Agendar: ModalInfoCita (éxito) o ModalError de máximo de citas
            // (cliente ya agendó por su cuenta → scheduled sin date/hour).
            { accion: 'agendarCita', desc: 'Agendar cita' },
        ],

        // Selectores del par calendario + horas del PasoDos.
        fechaYHora: {
            selBoton: 'div[tipo="Control"][pantalla="PasoDos"][nombre="btnFecha"]',
            // El calendario vive siempre en el DOM; su tabla visible es la señal
            // de que está desplegado.
            selAbierto: 'div[nombrecontrol="Calendario"] table.k-calendar-table',
            // Kendo marca con k-disabled los días sin cupo y con k-other-month los
            // días de relleno del mes siguiente. Las citas solo salen en el mes en
            // curso, así que se descartan ambos y nunca se cambia de mes.
            selDia:
                'div[nombrecontrol="Calendario"] td.k-calendar-td:not(.k-disabled):not(.k-other-month) a.k-link',
            selHoras: 'div[nombrecontrol="Horas"] select.customSelect',
            // Solo se muestra habilitado cuando el player aceptó la hora.
            selSiguiente: 'div[tipo="Control"][pantalla="PasoDos"][nombre="btnSiguiente"]',
            // Cuánto esperar a que el calendario se despliegue tras el clic.
            timeoutCalendarioMs: 15000,
            // Cuánto esperar a que el calendario pinte días habilitados.
            timeoutDiasMs: 10000,
            // Cuánto esperar las horas de un día antes de descartarlo y probar el
            // siguiente. Margen alto: a veces el texto aparece antes que el value.
            timeoutHorasMs: 20000,
            // Tras elegir la hora, cuánto esperar la confirmación del player
            // (hora seleccionada o Siguiente habilitado) antes de reintentar.
            confirmarHoraMs: 5000,
            // Veces que se vuelve a aplicar la hora si el player rehízo el select.
            intentosHora: 3,
        },

        captcha: {
            // reCAPTCHA escribe su token en este textarea de la propia página al
            // marcar la casilla: es la señal fiable de que ya está resuelto.
            selToken: '#g-recaptcha-response',
            // Margen para que llegues al navegador y lo marques.
            timeoutMs: 10 * 60 * 1000,
        },

        // Pasos posteriores al captcha: la cita ya está a la vista y recargar la
        // perdería, así que en vez de abortar se insiste y luego se pide ayuda.
        faseFinal: {
            // Si un clic no hace avanzar la página en este tiempo, se repite.
            // Mientras se ve la capa de carga no cuenta como "no avanzó".
            reintentoMs: 8000,
            // Cuánto se insiste solo antes de hacer sonar la alarma.
            timeoutMs: 90000,
            // Cuánto se espera a que la persona lo destrabe tras la alarma.
            esperaPersonaMs: 5 * 60 * 1000,
            // Veces que se reescribe el documento si su consulta no responde.
            intentosDocumento: 3,
        },

        alarma: {
            bipsPorRafaga: 12,
            // La alarma se repite hasta que marcas el captcha, no suena una sola vez.
            segundosEntreRafagas: 10,
            // 0 a 1. Por encima de 0.8 la onda cuadrada empieza a saturar.
            volumen: 0.8,
        },

        // Aviso que muestra la página cuando la combinación elegida no tiene cupo.
        // Se compara sin tildes, sin mayúsculas y con los espacios colapsados.
        textoSinCupo: 'No se encontraron especialidades relacionadas según los filtros seleccionados',

        // Tras Agendar: el cliente ya tiene cita (agendó por fuera). Se marca
        // scheduled sin date/hour y se sigue con el siguiente, sin alarma.
        textosClienteConCita: [
            'El usuario excedió el número máximo de citas por día para el mismo servicio',
            'El usuario excedió el número máximo de citas solicitadas abiertas',
        ],

        // El player bloquea la petición: Aceptar deja la página trabada, recargar.
        textoBloqueoSeguridad: 'solicitud bloqueada por controles de seguridad',

        sinEspecialidades: {
            // El aviso sale en la pantalla ModalError, que es genérica; el botón se
            // localiza por su pantalla para no confundirlo con el de otro modal.
            selAceptar: 'div[tipo="Control"][pantalla="ModalError"][nombre="btnAceptar"]',
            selServicios: 'div[nombrecontrol="Servicios"] select.customSelect',
            // Si Servicios ya tiene opciones se sale al momento; si no, se espera
            // el ModalError (o el timeout) sin gastar 4 s fijos en cada ciclo bueno.
            timeoutMs: 3000,
        },
    };

    // ─────────────────────────── ESTADO PERSISTENTE ───────────────────────────
    // Vive en localStorage: hace falta si hay recarga; el reintento suave no recarga.

    const CLAVE = 'ssMonitorState';
    const CLAVE_CLIENTES = 'ssMonitorClientes';
    const CLAVE_SHEET_URL = 'ssSheetUrl';
    const CLAVE_HOJA = 'ssSheetHoja';
    const CLAVE_INTERVALO = 'ssIntervaloSegundos';
    // Últimas líneas de diagnóstico (consola + localStorage). No es un archivo.
    const CLAVE_LOG = 'ssMonitorLog';

    // Contador en memoria: el soft-retry no recarga, así que no hace falta persistirlo.
    let softSeguidos = 0;
    let timerReintento = null;

    // URL del Apps Script: CONFIG.sheet.url (vacío en git) o localStorage local.
    const urlSheet = () => (CONFIG.sheet.url || localStorage.getItem(CLAVE_SHEET_URL) || '').trim();

    // Nombre de la pestaña / ciudad a la que apunta este PC.
    const nombreHoja = () => (CONFIG.sheet.hoja || localStorage.getItem(CLAVE_HOJA) || '').trim();

    // Periodicidad del reintento (dropdown del panel → localStorage).
    function intervaloSegundos() {
        const permitidos = CONFIG.intervalosSegundos || [5, 15, 30, 45, 60];
        const guardado = Number(localStorage.getItem(CLAVE_INTERVALO));
        if (permitidos.includes(guardado)) return guardado;
        const def = Number(CONFIG.intervaloSegundos) || 30;
        return permitidos.includes(def) ? def : permitidos[0];
    }
    const intervaloMs = () => intervaloSegundos() * 1000;

    // Caché por ciudad para no mezclar Bogotá con Medellín al cambiar de hoja.
    const claveClientes = () => {
        const hoja = nombreHoja();
        return hoja ? `${CLAVE_CLIENTES}:${hoja}` : CLAVE_CLIENTES;
    };

    // Cliente cuyo trámite se eligió en este ciclo. Su cédula se usa en el PasoTres
    // y se marca agendado cuando aparece el modal de éxito.
    let clienteActual = null;

    const leerEstado = () => {
        try {
            return JSON.parse(localStorage.getItem(CLAVE)) || {};
        } catch {
            return {};
        }
    };
    const guardarEstado = (parcial) => {
        const nuevo = { ...leerEstado(), ...parcial };
        localStorage.setItem(CLAVE, JSON.stringify(nuevo));
        return nuevo;
    };

    const guardarClientes = (lista) => localStorage.setItem(claveClientes(), JSON.stringify(lista));

    function leerClientesGuardados() {
        try {
            const raw = JSON.parse(localStorage.getItem(claveClientes()));
            return Array.isArray(raw) ? raw : [];
        } catch {
            return [];
        }
    }

    // ciudadTramite: arreglo ya listo, texto, varios separados por |, o JSON ["a","b"].
    function parseCiudadTramite(raw) {
        if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
        const s = String(raw == null ? '' : raw).trim();
        if (!s) return '';
        if (s.startsWith('[')) {
            try {
                const arr = JSON.parse(s);
                if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
            } catch {
                /* texto normal */
            }
        }
        if (s.includes('|')) return s.split('|').map((x) => x.trim()).filter(Boolean);
        return s;
    }

    function parseScheduled(v) {
        if (v === true || v === 1) return true;
        if (v === false || v === 0 || v == null || v === '') return false;
        const s = String(v).trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'yes' || s === 'si' || s === 'sí';
    }

    function normalizarClienteRemoto(c) {
        if (!c || c.cedula == null || c.cedula === '') return null;
        const ciudadTramite = parseCiudadTramite(c.ciudadTramite);
        if (!ciudadTramite || (Array.isArray(ciudadTramite) && !ciudadTramite.length)) return null;
        const cedula = String(c.cedula).replace(/\D/g, '') || String(c.cedula);
        const scheduled = parseScheduled(c.scheduled);
        const fecha = (c.date || (c.cita && c.cita.fecha) || '').toString().trim();
        const hora = (c.hour || (c.cita && c.cita.hora) || '').toString().trim();
        const entrada = {
            cedula: /^\d+$/.test(cedula) ? Number(cedula) : c.cedula,
            ciudadTramite,
            scheduled,
        };
        if (fecha || hora || (c.cita && c.cita.tramite)) {
            entrada.cita = {
                fecha,
                hora,
                tramite: (c.cita && c.cita.tramite) || '',
                agendadoEn: (c.cita && c.cita.agendadoEn) || '',
            };
        }
        return entrada;
    }

    // La Sheet es la fuente de verdad de scheduled/date/hour.
    // localStorage solo cachea la última sincronización (y respaldo si falla la red).
    function agendadoReciente(c) {
        if (!c || !c.scheduled || !c.cita || !c.cita.agendadoEn) return false;
        const edad = Date.now() - Date.parse(c.cita.agendadoEn);
        return edad >= 0 && edad < CONFIG.sheet.proteccionAgendadoMs;
    }

    function fusionarClientes(base, { sheetManda = false } = {}) {
        const guardados = leerClientesGuardados();
        const porCedula = new Map(guardados.map((c) => [String(c.cedula), c]));

        const lista = base
            .map((c) => normalizarClienteRemoto(c))
            .filter((c) => c && c.cedula != null && c.ciudadTramite)
            .map((c) => {
                const previo = porCedula.get(String(c.cedula));
                if (sheetManda) {
                    if (!c.scheduled && agendadoReciente(previo)) {
                        return { ...c, scheduled: true, cita: previo.cita, name: previo.name, email: previo.email };
                    }
                    return c;
                }
                // Respaldo local / CLIENTES_INICIALES: conservar scheduled local.
                const entrada = {
                    ...c,
                    scheduled: !!(c.scheduled || (previo && previo.scheduled)),
                };
                if (!entrada.cita && previo && previo.cita) entrada.cita = previo.cita;
                return entrada;
            });

        guardarClientes(lista);
        return lista;
    }

    function cargarClientes() {
        return leerClientesGuardados();
    }

    function gmRequest({ method, url, data }) {
        const { timeoutMs } = CONFIG.sheet;
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('falta el permiso GM_xmlhttpRequest en Tampermonkey'));
                return;
            }
            GM_xmlhttpRequest({
                method,
                url,
                data,
                timeout: timeoutMs,
                anonymous: true,
                headers: data ? { 'Content-Type': 'application/json' } : undefined,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error('HTTP ' + res.status));
                        return;
                    }
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: () => reject(new Error('error de red al hablar con la Sheet')),
                ontimeout: () => reject(new Error('timeout al hablar con la Sheet')),
            });
        });
    }

    function pedirClientesSheet() {
        const url = urlSheet();
        const hoja = nombreHoja();
        if (!url) return Promise.reject(new Error('no hay URL de Sheet configurada'));
        if (!hoja) return Promise.reject(new Error('no hay ciudad/hoja configurada'));
        const sep = url.includes('?') ? '&' : '?';
        const qs = new URLSearchParams({ hoja });
        return gmRequest({ method: 'GET', url: url + sep + qs.toString() }).then((data) => {
            const arr = Array.isArray(data) ? data : data && data.clientes;
            if (!Array.isArray(arr)) throw new Error('la respuesta no trae un arreglo de clientes');
            return arr.map(normalizarClienteRemoto).filter(Boolean);
        });
    }

    // GET con action=schedule (más fiable que POST con los redirects de Apps Script).
    function actualizarClienteSheet({ cedula, date, hour, name, email, scheduled = true }) {
        const base = urlSheet();
        const hoja = nombreHoja();
        if (!base) return Promise.reject(new Error('no hay URL de Sheet configurada'));
        if (!hoja) return Promise.reject(new Error('no hay ciudad/hoja configurada'));
        const sep = base.includes('?') ? '&' : '?';
        const qs = new URLSearchParams({
            action: 'schedule',
            hoja,
            cedula: String(cedula),
            scheduled: scheduled ? 'true' : 'false',
            date: date || '',
            hour: hour || '',
            name: name || '',
            email: email || '',
        });
        return gmRequest({ method: 'GET', url: base + sep + qs.toString() }).then((data) => {
            if (!data || data.ok === false) throw new Error((data && data.error) || 'la Sheet rechazó la actualización');
            return data;
        });
    }

    const claveSync = () => `ssSheetSyncAt:${nombreHoja()}`;
    let refrescoEnCurso = false;

    function refrescarSheetEnFondo() {
        if (refrescoEnCurso) return;
        refrescoEnCurso = true;
        pedirClientesSheet()
            .then((remotos) => {
                if (!remotos.length) return;
                fusionarClientes(remotos, { sheetManda: true });
                localStorage.setItem(claveSync(), String(Date.now()));
                log(`Sheet refrescada en segundo plano (${remotos.filter((c) => !c.scheduled).length} pendiente(s))`);
            })
            .catch((e) => log(`refresco de la Sheet falló: ${e.message}`))
            .finally(() => {
                refrescoEnCurso = false;
            });
    }

    // Al inicio de cada ciclo. Si la Sheet falla, se usa la última caché local
    // (nunca CLIENTES_INICIALES vacío: eso hacía creer que "todos están agendados").
    // confiable=true solo cuando la Sheet respondió bien: solo entonces FinCola.
    // Con pendientes en la caché no se espera a la Sheet: se usa la caché y, si
    // está vieja, se refresca en segundo plano para el ciclo siguiente.
    async function sincronizarClientes() {
        const cache = leerClientesGuardados();
        const { activo } = CONFIG.sheet;
        const url = urlSheet();
        const hoja = nombreHoja();

        if (!activo || !url) {
            if (cache.length) {
                log(`Sheet sin URL; se usa caché local (${cache.length} clientes)`);
                return { clientes: cache, confiable: false };
            }
            const lista = fusionarClientes(CLIENTES_INICIALES);
            return { clientes: lista, confiable: false };
        }

        if (!hoja) {
            throw new Error('elige la ciudad en el dropdown del panel');
        }

        const edad = Date.now() - Number(localStorage.getItem(claveSync()) || 0);
        if (cache.some((c) => !c.scheduled) && edad < CONFIG.sheet.edadMaximaCacheSegundos * 1000) {
            if (edad >= CONFIG.sheet.refrescoSegundos * 1000) refrescarSheetEnFondo();
            return { clientes: cache, confiable: false };
        }

        try {
            const remotos = await pedirClientesSheet();
            if (!remotos.length) {
                if (cache.length) {
                    log(`Hoja "${hoja}" vacía; se conserva la caché local`);
                    return { clientes: cache, confiable: false };
                }
                return { clientes: [], confiable: true };
            }
            const pendientes = remotos.filter((c) => !c.scheduled).length;
            log(`Hoja "${hoja}": ${remotos.length} cliente(s), ${pendientes} pendiente(s)`);
            localStorage.setItem(claveSync(), String(Date.now()));
            return {
                clientes: fusionarClientes(remotos, { sheetManda: true }),
                confiable: true,
            };
        } catch (e) {
            if (cache.length) {
                log(`Sheet falló (${e.message}); se usa caché local (${cache.length} clientes)`);
                return { clientes: cache, confiable: false };
            }
            throw new Error(`no se pudo leer la Sheet y no hay caché local: ${e.message}`);
        }
    }

    function textoPasoCuatro(nombre) {
        const el = document.querySelector(`div[tipo="Control"][pantalla="PasoCuatro"][nombre="${nombre}"]`);
        if (!el) return '';
        return ((el.innerText || el.textContent || '').replace(/\s+/g, ' ')).trim();
    }

    // Nombre y correo tal como los muestra el PasoCuatro (ofuscados por habeas
    // data). Se leen antes de Agendar, mientras la pantalla está visible.
    let datosPersonaActual = { nombre: '', correo: '' };

    function leerDatosPersona() {
        return {
            nombre: textoPasoCuatro('txtInfoNombres'),
            correo: textoPasoCuatro('txtInfoCorreo'),
        };
    }

    // El resumen de la cita vive en el PasoCuatro; al llegar al modal de éxito
    // esas pantallas siguen en el DOM.
    function leerResumenCita() {
        return {
            fecha: textoPasoCuatro('txtInfoFecha'),
            hora: textoPasoCuatro('txtInfoHora'),
            tramite: textoPasoCuatro('txtInfoServicio'),
            agendadoEn: new Date().toISOString(),
        };
    }

    async function marcarAgendado(opts = {}) {
        if (!clienteActual) return;
        const lista = cargarClientes();
        const cliente = lista.find((c) => String(c.cedula) === String(clienteActual.cedula));
        if (!cliente) return;

        const sinFechaHora = !!opts.sinFechaHora;
        const cita = sinFechaHora
            ? {
                  fecha: '',
                  hora: '',
                  tramite: (cliente.ciudadTramite || '').toString(),
                  agendadoEn: new Date().toISOString(),
                  motivo: opts.motivo || 'max_citas_dia',
              }
            : leerResumenCita();

        const persona = datosPersonaActual.nombre || datosPersonaActual.correo
            ? datosPersonaActual
            : leerDatosPersona();
        cliente.scheduled = true;
        cliente.cita = cita;
        cliente.name = persona.nombre;
        cliente.email = persona.correo;
        if (sinFechaHora) {
            cliente.date = '';
            cliente.hour = '';
        }
        guardarClientes(lista);
        log(
            sinFechaHora
                ? `   ${cliente.cedula} marcado scheduled (sin date/hour): ${opts.motivo || 'ya tenía cita'}`
                : `   ${cliente.cedula} agendado: ${cita.fecha || '?'} ${cita.hora || '?'} — ${
                      cita.tramite || cliente.ciudadTramite
                  }`,
        );

        try {
            await actualizarClienteSheet({
                cedula: cliente.cedula,
                scheduled: true,
                date: sinFechaHora ? '' : cita.fecha,
                hour: sinFechaHora ? '' : cita.hora,
                name: persona.nombre,
                email: persona.correo,
            });
            log(
                sinFechaHora
                    ? '   Sheet actualizada (scheduled=true, date/hour vacíos, name/email)'
                    : '   Sheet actualizada (scheduled/date/hour/name/email)',
            );
        } catch (e) {
            log('   no se pudo actualizar la Sheet: ' + e.message);
        }
    }

    function exportarCitas() {
        const agendados = cargarClientes().filter((c) => c.scheduled);
        if (!agendados.length) {
            pintar('No hay citas agendadas para exportar.');
            return;
        }
        const blob = new Blob([JSON.stringify(agendados, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `citas-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        pintar(`Exportadas ${agendados.length} cita(s).`);
    }

    // ───────────────────────────── UTILIDADES DOM ─────────────────────────────

    // El flujo llegó al final y simplemente no había nada: es un resultado
    // esperado, no un fallo del script, y el ciclo lo reporta distinto.
    class SinCupo extends Error {
        constructor(mensaje) {
            super(mensaje);
            this.name = 'SinCupo';
        }
    }

    // La cola se acabó: no tiene sentido seguir recargando.
    class FinCola extends Error {
        constructor(mensaje) {
            super(mensaje);
            this.name = 'FinCola';
        }
    }

    // Agendar devolvió el tope diario: se marca scheduled y se pasa al siguiente.
    class ClienteYaAgendado extends Error {
        constructor(mensaje) {
            super(mensaje);
            this.name = 'ClienteYaAgendado';
        }
    }

    const esSinCupo = (e) => !!(e && (e instanceof SinCupo || e.name === 'SinCupo'));
    const esFinCola = (e) => !!(e && (e instanceof FinCola || e.name === 'FinCola'));
    const esClienteYaAgendado = (e) =>
        !!(e && (e instanceof ClienteYaAgendado || e.name === 'ClienteYaAgendado'));

    class BloqueoSeguridad extends Error {
        constructor(mensaje) {
            super(mensaje);
            this.name = 'BloqueoSeguridad';
        }
    }
    const esBloqueoSeguridad = (e) =>
        !!(e && (e instanceof BloqueoSeguridad || e.name === 'BloqueoSeguridad'));

    const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

    const visible = (el) => !!(el && el.offsetParent !== null);

    // offsetParent falla con algunos contenedores del player; rect + computedStyle.
    function visibleEnPantalla(el) {
        if (!el) return false;
        if (visible(el)) return true;
        const st = estiloDe(el);
        if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0)) {
            return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    const vistaPagina = () => (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

    // Sin tildes, sin mayúsculas y con los espacios colapsados, para que
    // "Bogotá - Univ. La Gran Colombia" case con "Bogota".
    const normalizar = (s) =>
        s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

    // Las opciones del trámite vienen entre comillas y a veces con un punto final.
    // Se las quita para compararlas con ciudadTramite.
    const limpiarTramite = (s) => normalizar(String(s)).replace(/["“”«»'`´.]/g, '').replace(/\s+/g, ' ').trim();

    function estiloDe(el) {
        try {
            return vistaPagina().getComputedStyle(el);
        } catch (_) {
            return null;
        }
    }

    // Modales del player usan position:absolute + display:none; offsetParent no
    // basta. Se mira display/visibility del [tipo=Pantalla].
    function pantallaOverlayVisible(nombre) {
        const pantalla = document.querySelector(
            `div[nombrepantalla="${nombre}"] [tipo="Pantalla"][nombre="${nombre}"]`,
        );
        if (!pantalla) return false;
        const st = estiloDe(pantalla);
        if (st) return st.display !== 'none' && st.visibility !== 'hidden';
        const inline = pantalla.getAttribute('style') || '';
        if (/display\s*:\s*none/i.test(inline)) return false;
        return pantalla.style.display !== 'none';
    }

    function estaCargando() {
        const sels = (CONFIG.cargando && CONFIG.cargando.sels) || ['#mpcWPdivCargando'];
        for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) continue;
            if (el.classList && el.classList.contains('contenidoOculto')) continue;
            const st = estiloDe(el);
            if (st) {
                if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
                if (el.offsetWidth > 0 || el.offsetHeight > 0 || st.display === 'flex' || st.display === 'block') {
                    return true;
                }
            } else if (visible(el)) {
                return true;
            }
        }
        return false;
    }

    function textoModalErrorVisible() {
        if (!pantallaOverlayVisible('ModalError')) return '';
        const modal = document.querySelector('div[nombrepantalla="ModalError"]');
        return normalizar((modal && modal.innerText) || '');
    }

    // Solo el aviso de especialidades — no cualquier ModalError (p. ej. máximo de citas).
    function hayModalSinCupo() {
        const aviso = normalizar(CONFIG.textoSinCupo);
        if (!aviso) return false;
        return textoModalErrorVisible().includes(aviso);
    }

    // Devuelve el aviso de "cliente ya tiene cita" que esté en pantalla, o ''.
    function hayModalMaxCitasDia() {
        const texto = textoModalErrorVisible();
        if (!texto) return '';
        return (CONFIG.textosClienteConCita || []).find((t) => texto.includes(normalizar(t))) || '';
    }

    function hayModalBloqueoSeguridad() {
        const aviso = normalizar(CONFIG.textoBloqueoSeguridad || '');
        if (!aviso) return false;
        return textoModalErrorVisible().includes(aviso);
    }

    // No se pulsa Aceptar: deja el player trabado. Recarga y el arranque sigue.
    function recargarSiBloqueoSeguridad() {
        if (!hayModalBloqueoSeguridad()) return;
        recargarInicio('solicitud bloqueada por controles de seguridad');
        throw new BloqueoSeguridad('solicitud bloqueada por controles de seguridad');
    }

    async function cerrarModalError() {
        const sel =
            (CONFIG.sinEspecialidades && CONFIG.sinEspecialidades.selAceptar) ||
            'div[tipo="Control"][pantalla="ModalError"][nombre="btnAceptar"]';
        const aceptar =
            Array.from(document.querySelectorAll(sel)).find(visibleEnPantalla) || document.querySelector(sel);
        if (!aceptar) return false;
        log('   cerrando ModalError');
        clicar(resolverObjetivo(aceptar));
        await dormir(CONFIG.pausaEntrePasosMs);
        await esperarSinCarga(5000, { lanzarSinCupo: false });
        return true;
    }

    async function cerrarAvisoSinCupo(motivo) {
        await cerrarModalError();
        throw new SinCupo(motivo || 'no hay especialidades para el trámite');
    }

    async function esperarSinCarga(timeout, opts = {}) {
        const lanzarSinCupo = opts.lanzarSinCupo !== false;
        const porDefecto = (CONFIG.cargando && CONFIG.cargando.timeoutMs) || 15000;
        const limite = Date.now() + (timeout ?? porDefecto);
        while (Date.now() < limite) {
            recargarSiBloqueoSeguridad();
            if (lanzarSinCupo && hayModalSinCupo()) await cerrarAvisoSinCupo();
            if (!estaCargando()) {
                await dormir(50);
                if (!estaCargando()) return true;
            }
            await dormir(100);
        }
        return false;
    }

    async function esperarCualquiera(sels, timeout) {
        const lista = Array.isArray(sels)
            ? sels
            : String(sels)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
        const limite = Date.now() + timeout;
        while (Date.now() < limite) {
            recargarSiBloqueoSeguridad();
            if (hayModalSinCupo()) await cerrarAvisoSinCupo();
            for (const sel of lista) {
                const el = buscar(sel) || Array.from(document.querySelectorAll(sel)).find(visibleEnPantalla);
                if (el) return el;
            }
            await dormir(150);
        }
        return null;
    }

    async function estabilizarTrasPaso(paso) {
        recargarSiBloqueoSeguridad();
        if (hayModalSinCupo()) await cerrarAvisoSinCupo();
        await esperarSinCarga((CONFIG.cargando && CONFIG.cargando.timeoutMs) || 15000);
        if (paso.esperaHasta) {
            await esperarCualquiera(paso.esperaHasta, CONFIG.timeoutElementoMs);
        }
        if (hayModalSinCupo()) await cerrarAvisoSinCupo();
        const ms =
            paso.espera !== undefined
                ? paso.espera
                : CONFIG.esperaTrasClicMs !== undefined
                  ? CONFIG.esperaTrasClicMs
                  : CONFIG.pausaEntrePasosMs;
        if (ms > 0) await dormir(ms);
    }

    function buscar(sel, contiene) {
        const nodos = Array.from(document.querySelectorAll(sel)).filter(visible);
        if (!contiene) return nodos[0] || null;
        const objetivo = contiene.trim().toLowerCase();
        return nodos.find((n) => (n.innerText || n.value || '').trim().toLowerCase().includes(objetivo)) || null;
    }

    async function esperarElemento(sel, contiene, timeout) {
        if (!contiene && String(sel).includes(',')) {
            return esperarCualquiera(sel, timeout);
        }
        const limite = Date.now() + timeout;
        while (Date.now() < limite) {
            recargarSiBloqueoSeguridad();
            const el = buscar(sel, contiene);
            if (el) return el;
            await dormir(150);
        }
        return null;
    }

    function disparar(el, tipos) {
        tipos.forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
    }

    // Cada control del player es un <div tipo="Control"> envuelto por un div con
    // nombrecontrol. El manejador de clic está en el interior, y los eventos
    // burbujean hacia arriba, así que un clic en la envoltura no dispara nada.
    function resolverObjetivo(el) {
        if (el.getAttribute('tipo') === 'Control') return el;
        return el.querySelector('[tipo="Control"]') || el;
    }

    async function esperarOpcion(select, coincide, timeout) {
        const limite = Date.now() + timeout;
        while (Date.now() < limite) {
            const opcion = Array.from(select.options).find(coincide);
            if (opcion) return opcion;
            await dormir(250);
        }
        return null;
    }

    function clicar(el) {
        // Con @grant GM_xmlhttpRequest el script corre en un sandbox: window no es
        // la ventana de la página y PointerEvent rechaza view: window. Hay que
        // usar la ventana real (unsafeWindow) o no pasar view.
        const vista = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const opciones = { bubbles: true, cancelable: true, view: vista };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
            const Evento = t.startsWith('pointer') && vista.PointerEvent ? vista.PointerEvent : vista.MouseEvent;
            el.dispatchEvent(new Evento(t, opciones));
        });
    }

    // Elegir una opción de un <select> que el player llena al abrirlo.
    async function elegirOpcion(select, coincide, timeout) {
        const limite = Date.now() + timeout;
        let opcion = null;
        while (!opcion && Date.now() < limite) {
            select.focus();
            clicar(select);
            opcion = await esperarOpcion(select, coincide, 2000);
        }
        if (!opcion) return null;
        aplicarOpcionSelect(select, opcion);
        return opcion;
    }

    function aplicarOpcionSelect(select, opcion) {
        // selectedIndex es más fiable que value con cadenas tipo
        // "10/15/2026 2:00:00 PM" (formato real del select de Horas DIAN).
        select.selectedIndex = opcion.index;
        opcion.selected = true;
        if (String(opcion.value || '').trim() !== '') {
            select.value = opcion.value;
        }
        disparar(select, ['input', 'change']);
        select.blur();
    }

    // Formato real DIAN: texto "2:00 PM" / value "10/15/2026 2:00:00 PM".
    function esOpcionHora(o) {
        if (!o || o.disabled) return false;
        const texto = (o.textContent || '').replace(/\s+/g, ' ').trim();
        const value = String(o.value || '').trim();
        if (!value && !texto) return false;
        if (/\d{1,2}\s*:\s*\d{2}(\s*[AaPp]\.?\s*[Mm]\.?)?/.test(texto)) return true;
        if (/\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}/.test(value)) return true;
        if (!value) return false;
        if (/^(0|-1|null|undefined)$/i.test(value)) return false;
        if (/seleccion|elija|elige|hora/i.test(texto) && !/\d/.test(texto)) return false;
        return true;
    }

    function resumenOpcionesHoras(select) {
        if (!select) return 'sin select';
        const opts = Array.from(select.options);
        if (!opts.length) return 'sin options';
        return opts
            .map((o) => `"${(o.textContent || '').replace(/\s+/g, ' ').trim()}" value="${o.value}" disabled=${o.disabled}`)
            .join(' | ');
    }

    // Las horas que ofrece la página dependen del día elegido, así que un día
    // habilitado en el calendario no garantiza horas libres. Se recorren los días
    // habilitados y se toma el primero que sí tenga horas.
    async function elegirFechaYHora() {
        const {
            selBoton,
            selAbierto,
            selDia,
            selHoras,
            selSiguiente,
            timeoutCalendarioMs,
            timeoutDiasMs,
            timeoutHorasMs,
            confirmarHoraMs,
            intentosHora,
        } = CONFIG.fechaYHora;

        async function abrirCalendario() {
            // Un segundo clic con el calendario abierto lo cerraría, de ahí la
            // comprobación previa.
            if (buscar(selAbierto)) return;
            const boton = await esperarElemento(selBoton, null, CONFIG.timeoutElementoMs);
            if (!boton) {
                // Sin especialidades el PasoDos nunca se muestra: es un "no hay
                // cupo", no un fallo del script.
                if (avisoSinCupo()) throw new SinCupo('la página avisó que no hay especialidades');
                throw new Error('No apareció el botón de fecha');
            }
            await esperarSinCarga();
            clicar(resolverObjetivo(boton));
            if (!(await esperarElemento(selAbierto, null, timeoutCalendarioMs))) {
                throw new Error('El calendario no se desplegó');
            }
        }

        // El calendario puede pintarse antes de que lleguen los días con cupo.
        async function esperarDiasHabilitados() {
            const limite = Date.now() + timeoutDiasMs;
            while (Date.now() < limite) {
                const dias = Array.from(document.querySelectorAll(selDia))
                    .filter(visible)
                    .map((a) => a.getAttribute('data-value'))
                    .filter(Boolean);
                if (dias.length) return dias;
                await dormir(250);
            }
            return [];
        }

        const horaSeleccionada = (select) => {
            const o = select && select.options[select.selectedIndex];
            return esOpcionHora(o) ? o : null;
        };
        const siguienteListo = () => !!buscar(selSiguiente);

        // Re-consulta el <select> en cada sondeo (el player puede recrearlo).
        // La hora se aplica una vez y se espera la confirmación del player: al
        // disparar change rehace el select, y volver a aplicarla cada 250 ms lo
        // mantenía en ese ciclo hasta agotar el tiempo.
        async function esperarYElegirHora() {
            const limite = Date.now() + timeoutHorasMs;
            let aplicaciones = 0;
            let ultimaTexto = '';
            while (Date.now() < limite) {
                await esperarSinCarga();
                const select = buscar(selHoras);
                const elegida = horaSeleccionada(select);
                if (elegida && (aplicaciones > 0 || siguienteListo())) {
                    return { select, opcion: elegida, texto: elegida.textContent.trim() };
                }
                if (aplicaciones > 0 && siguienteListo()) {
                    return { select, opcion: elegida, texto: ultimaTexto };
                }

                const opcion = select && Array.from(select.options).find(esOpcionHora);
                if (!opcion) {
                    await dormir(250);
                    continue;
                }
                if (aplicaciones >= intentosHora) break;

                aplicaciones++;
                ultimaTexto = opcion.textContent.trim();
                log(`   aplicando hora ${ultimaTexto} (intento ${aplicaciones}/${intentosHora})`);
                select.focus();
                aplicarOpcionSelect(select, opcion);

                const limiteConfirmar = Math.min(limite, Date.now() + confirmarHoraMs);
                while (Date.now() < limiteConfirmar) {
                    await dormir(200);
                    const actual = buscar(selHoras);
                    const ok = horaSeleccionada(actual);
                    if (ok) return { select: actual, opcion: ok, texto: ok.textContent.trim() };
                    if (siguienteListo()) return { select: actual, opcion: null, texto: ultimaTexto };
                }
                const actual = buscar(selHoras);
                log(
                    `   la hora no se confirmó (index=${actual ? actual.selectedIndex : '-'}, ` +
                        `value="${actual ? actual.value : ''}")`,
                );
            }
            return { select: buscar(selHoras), opcion: null, aplicaciones };
        }

        await abrirCalendario();

        // Se guardan los data-value y no los nodos porque el calendario se vuelve
        // a dibujar cada vez que se abre y las referencias quedarían obsoletas.
        const dias = await esperarDiasHabilitados();

        if (!dias.length) throw new SinCupo('el calendario no tiene días habilitados');
        log(`   días habilitados: ${dias.length}`);

        let ultimoDetalle = '';
        for (const valor of dias) {
            await abrirCalendario();

            const dia = buscar(`${selDia}[data-value="${valor}"]`);
            if (!dia) {
                log(`   el día ${valor} ya no está habilitado`);
                continue;
            }

            log(`   probando ${dia.title || valor}`);
            clicar(dia);
            await esperarSinCarga();
            await dormir(CONFIG.esperaTrasClicMs ?? 200);

            const resultado = await esperarYElegirHora();
            if (resultado.opcion || resultado.texto) {
                const valorHora = resultado.opcion ? ` (value="${resultado.opcion.value}")` : '';
                log(`   hora elegida: ${resultado.texto}${valorHora}`);
                // Hay cupo de verdad: el operario se prepara y el AHK ya busca
                // la casilla mientras carga el captcha.
                detener('¡CUPOS! Hay fecha y hora. Prepárate para el captcha.');
                log('fecha y hora → alarma y título CUPOS');
                return true;
            }

            ultimoDetalle = resumenOpcionesHoras(resultado.select);
            log(
                resultado.aplicaciones
                    ? `   el player no aceptó la hora tras ${resultado.aplicaciones} intento(s) (${ultimoDetalle})`
                    : `   ese día no tiene horas libres (${ultimoDetalle})`,
            );
        }

        throw new SinCupo(
            ultimoDetalle
                ? `ningún día habilitado tiene horas libres [${ultimoDetalle}]`
                : 'ningún día habilitado tiene horas libres',
        );
    }

    // Widget / pantalla del captcha (el textarea del token casi siempre está oculto).
    function captchaUiPresente() {
        if (document.querySelector('iframe[src*="recaptcha"]')) return true;
        if (document.querySelector('iframe[title*="reCAPTCHA"], iframe[title*="recaptcha"]')) return true;
        if (document.querySelector('.g-recaptcha, [data-sitekey]')) return true;
        if (document.querySelector('#g-recaptcha-response')) return true;
        const paso = document.querySelector(
            'div[nombrepantalla="PasoTres"] [tipo="Pantalla"][nombre="PasoTres"]',
        );
        if (!paso) return false;
        const st = estiloDe(paso);
        if (st) return st.display !== 'none' && st.visibility !== 'hidden';
        return visibleEnPantalla(paso);
    }

    // El reCAPTCHA vive en un iframe de google.com: el script no puede marcarlo
    // (es otro origen) y Google rechaza los clics sintéticos incluso si pudiera.
    // Lo resuelve la persona. La alarma y CUPOS ya están activos desde la hora.
    async function esperarCaptcha() {
        const { selToken, timeoutMs } = CONFIG.captcha;

        const limiteUi = Date.now() + CONFIG.timeoutElementoMs;
        while (Date.now() < limiteUi && !captchaUiPresente()) {
            await dormir(150);
        }
        if (!captchaUiPresente()) throw new Error('No apareció el captcha');
        log('captcha en pantalla, esperando que lo marquen');

        const limite = Date.now() + timeoutMs;
        let tarde = false;
        while (Date.now() < limite) {
            if (!tarde) tarde = marcarTerminosTemprano();
            const token = document.querySelector(selToken);
            // Sin recargar entre clientes, el token del cliente anterior podría
            // seguir en el textarea: solo cuenta uno nuevo.
            if (token && token.value && token.value !== tokenCaptchaUsado) {
                tokenCaptchaUsado = token.value;
                pararAlarma();
                log('captcha resuelto, continuando');
                return true;
            }
            await dormir(100);
        }
        pararAlarma();
        throw new Error('el captcha no se resolvió a tiempo');
    }

    // El check de términos ya está en pantalla junto al captcha: se marca mientras
    // la persona resuelve el captcha para no gastar ese tiempo después.
    // Devuelve true cuando el check ya quedó marcado.
    function marcarTerminosTemprano() {
        const el = primeroVisible('div[nombrecontrol="TerminosCondiciones"] input[type="checkbox"]');
        if (!el) return false;
        if (el.checked) return true;
        clicar(el);
        if (!el.checked) {
            el.checked = true;
            disparar(el, ['input', 'change']);
        }
        log('   términos marcados antes del captcha');
        return true;
    }

    let tokenCaptchaUsado = '';

    // ───────────────────────────── FASE FINAL ─────────────────────────────────

    const SEL_AGENDAR = 'div[tipo="Control"][pantalla="PasoCuatro"][nombre="btnAgendarCita"]';

    function primeroVisible(sels) {
        const lista = (Array.isArray(sels) ? sels : String(sels).split(','))
            .map((s) => s.trim())
            .filter(Boolean);
        for (const sel of lista) {
            const el = buscar(sel) || Array.from(document.querySelectorAll(sel)).find(visibleEnPantalla);
            if (el) return el;
        }
        return null;
    }

    // Texto de un ModalError que no sea el de máximo de citas (ese tiene su manejo).
    function modalErrorInesperado() {
        if (!pantallaOverlayVisible('ModalError') || hayModalMaxCitasDia()) return '';
        const modal = document.querySelector('div[nombrepantalla="ModalError"]');
        return ((modal && modal.innerText) || 'aviso de error').replace(/\s+/g, ' ').trim();
    }

    // La página se trabó en un paso final: sin alarma, se enciende de nuevo el
    // monitor (detener() lo apagó en el captcha) y el ciclo recarga y reintenta;
    // el cliente sigue pendiente.
    function fallaFaseFinal(motivo) {
        guardarEstado({ activo: true });
        refrescarBoton();
        return new Error(motivo);
    }

    // Clic que debe llevar a la pantalla siguiente (paso.esperaHasta). Si no
    // avanza, se repite el clic; si tras timeoutMs sigue igual, se pide ayuda.
    async function clicHastaAvanzar(paso) {
        const { reintentoMs, timeoutMs } = CONFIG.faseFinal;
        const desc = paso.desc || paso.sel;
        const avanzo = () => !!primeroVisible(paso.esperaHasta);
        const limite = Date.now() + timeoutMs;
        let clics = 0;
        while (Date.now() < limite && !avanzo()) {
            recargarSiBloqueoSeguridad();
            const aviso = modalErrorInesperado();
            if (aviso) {
                log(`   ModalError en ${desc}: ${aviso}`);
                await cerrarModalError();
                guardarEstado({ activo: true });
                refrescarBoton();
                throw new SinCupo(`en ${desc}: ${aviso}`);
            }
            if (estaCargando()) {
                await dormir(200);
                continue;
            }
            const el = primeroVisible(paso.sel);
            if (!el) {
                await dormir(100);
                continue;
            }
            clics++;
            if (clics > 1) log(`   ${desc} no avanzó; clic ${clics}`);
            el.scrollIntoView({ block: 'center' });
            clicar(resolverObjetivo(el));
            let limiteClic = Date.now() + reintentoMs;
            while (Date.now() < Math.min(limiteClic, limite) && !avanzo() && !modalErrorInesperado()) {
                if (estaCargando()) limiteClic = Math.max(limiteClic, Date.now() + 1000);
                await dormir(200);
            }
        }
        if (!avanzo()) throw fallaFaseFinal(`${desc} no avanza`);
        await dormir(paso.espera ?? CONFIG.esperaTrasClicMs ?? 200);
    }

    async function ejecutarPasoFinal(paso) {
        if (paso.accion === 'documento') {
            await escribirDocumento();
            await dormir(paso.espera ?? CONFIG.esperaTrasClicMs ?? 200);
            return true;
        }
        if (paso.accion === 'agendarCita') return agendarCitaYConfirmar();
        if (paso.sel && !paso.marcar && paso.esperaHasta) return clicHastaAvanzar(paso);
        try {
            return await ejecutarPaso(paso);
        } catch (e) {
            if (esSinCupo(e) || esClienteYaAgendado(e)) throw e;
            throw fallaFaseFinal(`${paso.desc || paso.sel}: ${e.message}`);
        }
    }

    // La lista de trámites cambia en cada ciclo. Se recorre la cola y se queda con
    // el primer pendiente cuya ciudadTramite esté entre las opciones.
    async function elegirTramite() {
        const sel = 'div[nombrecontrol="Servicios"] select.customSelect';
        const select = await esperarElemento(sel, null, CONFIG.timeoutElementoMs);
        if (!select) {
            throw new SinCupo('No apareció el trámite');
        }
        select.scrollIntoView({ block: 'center' });

        const pendientes = cargarClientes().filter((c) => !c.scheduled);
        if (!pendientes.length) throw new FinCola('Todos los clientes ya están agendados');

        const limite = Date.now() + CONFIG.timeoutElementoMs;
        let opciones = Array.from(select.options).filter((o) => o.value !== '');
        let clics = 0;
        while (!opciones.length && Date.now() < limite) {
            // Un clic por cada silencio, no en cada sondeo: repetirlo cierra la
            // lista que acaba de abrir y la carga vuelve a empezar.
            if (clics < 3) {
                select.focus();
                clicar(select);
                clics++;
            }
            await dormir(150);
            opciones = Array.from(select.options).filter((o) => o.value !== '');
        }
        if (!opciones.length) {
            throw new SinCupo('el trámite no cargó opciones');
        }

        log(`   opciones de trámite: ${opciones.length}`);
        const textos = opciones.map((o) => ({ opcion: o, texto: limpiarTramite(o.textContent) }));
        for (const cliente of pendientes) {
            // Arreglo = preferencias en orden; string = un solo candidato.
            const candidatos = Array.isArray(cliente.ciudadTramite)
                ? cliente.ciudadTramite
                : [cliente.ciudadTramite];

            let hallado = null;
            for (const candidato of candidatos) {
                const objetivo = limpiarTramite(candidato);
                hallado = textos.find((t) => t.texto.includes(objetivo));
                if (hallado) break;
            }

            if (!hallado) {
                log(`   ${cliente.cedula} sin opción para ${JSON.stringify(candidatos)}`);
                continue;
            }

            select.value = hallado.opcion.value;
            disparar(select, ['input', 'change']);
            select.blur();
            clienteActual = cliente;
            datosPersonaActual = { nombre: '', correo: '' };
            log(`   cliente ${cliente.cedula}: ${hallado.opcion.textContent.trim()}`);
            return true;
        }

        throw new SinCupo('ningún cliente pendiente coincide con los trámites disponibles');
    }

    // La consulta del documento se dispara al salir del campo. Si la página está
    // lenta y no responde, se vuelve a escribir y a salir del campo; si tampoco,
    // se pide ayuda en vez de abortar (ya pasó el captcha).
    async function escribirDocumento() {
        if (!clienteActual) throw new Error('No hay un cliente seleccionado para el documento');

        const { intentosDocumento, reintentoMs } = CONFIG.faseFinal;
        const selRespuesta = [
            'div[nombrecontrol="DatosCorretos"] input[type="radio"][value="1"]',
            'div[nombrecontrol="TerminosCondiciones"] input[type="checkbox"]',
        ];
        const respondio = () => !!primeroVisible(selRespuesta);

        for (let intento = 1; intento <= intentosDocumento; intento++) {
            const campo = await esperarElemento(
                '#divPasoTresNumeroDocumento input',
                null,
                CONFIG.timeoutElementoMs,
            );
            if (!campo) break;
            if (intento > 1) log(`   la consulta del documento no respondió; intento ${intento}`);

            campo.scrollIntoView({ block: 'center' });
            campo.focus();
            campo.value = '';
            campo.value = String(clienteActual.cedula);
            disparar(campo, ['input', 'change', 'keyup']);
            campo.blur();
            clicar(document.body);
            log(`   documento ${clienteActual.cedula}`);

            await esperarSinCarga();
            if (await esperarCualquiera(selRespuesta, reintentoMs * 2)) return;
        }
        if (!respondio()) throw fallaFaseFinal('La consulta del documento no responde');
    }

    // Al elegir el trámite la página puede responder con el modal de que no hay
    // especialidades. Es un "no hay cupo" temprano: se cierra el aviso y se
    // reintenta pronto, sin recorrer el resto del flujo.
    async function revisarSinEspecialidades() {
        const { timeoutMs, selServicios } = CONFIG.sinEspecialidades;
        const selSvc = selServicios || 'div[nombrecontrol="Servicios"] select.customSelect';
        const limite = Date.now() + timeoutMs;

        while (Date.now() < limite) {
            // Si el trámite ya tiene opciones, no hay modal que esperar.
            const select = document.querySelector(selSvc);
            if (select && Array.from(select.options).some((o) => o.value !== '')) return true;

            recargarSiBloqueoSeguridad();
            if (hayModalSinCupo()) await cerrarAvisoSinCupo();
            await dormir(150);
        }
        return true;
    }

    async function ejecutarPaso(paso) {
        if (paso.accion === 'sinEspecialidades') {
            await revisarSinEspecialidades();
            return true;
        }

        if (paso.accion === 'tramite') {
            await elegirTramite();
            await estabilizarTrasPaso(paso);
            return true;
        }

        if (paso.accion === 'documento') {
            await escribirDocumento();
            await estabilizarTrasPaso(paso);
            return true;
        }

        if (paso.accion === 'fechaYHora') {
            await elegirFechaYHora();
            await estabilizarTrasPaso(paso);
            return true;
        }

        if (paso.accion === 'captcha') {
            await esperarCaptcha();
            await estabilizarTrasPaso(paso);
            return true;
        }

        if (paso.accion === 'agendarCita') {
            await agendarCitaYConfirmar();
            return true;
        }

        const el = await esperarElemento(paso.sel, paso.contiene, CONFIG.timeoutElementoMs);
        if (!el) {
            if (paso.opcional) {
                log(`paso opcional omitido: ${paso.desc || paso.sel}`);
                return true;
            }
            throw new Error(`No apareció: ${paso.desc || paso.sel}`);
        }

        // Radio/checkbox ya en Sí: no reclicar ni forzar esperas largas.
        if (paso.marcar && paso.omitirSiMarcado && el.checked) {
            log('   ya estaba marcado, se omite');
            await estabilizarTrasPaso(paso);
            return true;
        }

        el.scrollIntoView({ block: 'center' });

        if (paso.opcionContiene !== undefined || paso.primeraOpcion) {
            // La primera opción de estos selects es un <option value=""> de relleno,
            // así que "la primera" es en realidad la primera con valor.
            const objetivo = paso.opcionContiene !== undefined ? normalizar(paso.opcionContiene) : null;
            const coincide =
                objetivo === null
                    ? (o) => o.value !== ''
                    : (o) => normalizar(o.textContent).includes(objetivo);

            const opcion = await elegirOpcion(el, coincide, CONFIG.timeoutElementoMs);
            if (!opcion) {
                if (paso.opcional) {
                    log(`paso opcional omitido: ${paso.desc || paso.sel}`);
                    return true;
                }
                const motivo =
                    objetivo === null
                        ? 'No se cargó ninguna opción'
                        : `Ninguna opción contiene "${paso.opcionContiene}"`;
                throw new Error(`${motivo} en ${paso.desc || paso.sel}`);
            }
            log(`   opción elegida: ${opcion.textContent.trim()}`);
        } else if (paso.valor !== undefined) {
            el.value = paso.valor;
            disparar(el, ['input', 'change']);
        } else if (paso.texto !== undefined) {
            el.focus();
            el.value = paso.texto;
            disparar(el, ['input', 'change', 'keyup']);
            // La consulta del documento se dispara al salir del campo, que es el
            // "clic afuera" de hacerlo a mano.
            el.blur();
            clicar(document.body);
        } else if (paso.marcar) {
            if (el.checked) {
                log('   ya estaba marcado');
            } else {
                // Un clic sintético sí activa radios y checkboxes nativos, y de paso
                // dispara los input/change que el player escucha.
                clicar(el);
                if (!el.checked) {
                    el.checked = true;
                    disparar(el, ['input', 'change']);
                }
            }
        } else {
            // El title de los días del calendario dice la fecha completa, útil
            // para saber después qué quedó elegido.
            if (el.title) log(`   ${el.title}`);
            clicar(resolverObjetivo(el));
        }

        await estabilizarTrasPaso(paso);
        return true;
    }

    // Tras Agendar: éxito (ModalInfoCita) o tope diario (ModalError) si ya tenía cita.
    async function agendarCitaYConfirmar() {
        const selOk =
            'div[tipo="Control"][pantalla="ModalInfoCita"][nombre="btnAceptar"]';

        const boton = await esperarElemento(SEL_AGENDAR, null, CONFIG.timeoutElementoMs);
        if (!boton) throw fallaFaseFinal('No apareció Agendar cita');

        datosPersonaActual = leerDatosPersona();
        log(`   datos: ${datosPersonaActual.nombre || '?'} / ${datosPersonaActual.correo || '?'}`);

        boton.scrollIntoView({ block: 'center' });
        clicar(resolverObjetivo(boton));
        log('   clic en Agendar cita');

        // No se repite el clic en Agendar: un segundo envío podría volver como
        // "máximo de citas" y registrarse mal. Si no responde, se avisa y se sigue
        // atento: si la persona confirma la cita a mano, igual se registra.
        const limite = Date.now() + CONFIG.timeoutElementoMs;
        let limiteAyuda = 0;
        for (;;) {
            recargarSiBloqueoSeguridad();
            const yaTieneCita = hayModalMaxCitasDia();
            if (yaTieneCita) {
                pararAlarma();
                log(`   ModalError: ${yaTieneCita}`);
                await marcarAgendado({
                    sinFechaHora: true,
                    motivo: normalizar(yaTieneCita).includes('abiertas') ? 'max_citas_abiertas' : 'max_citas_dia',
                });
                await cerrarModalError();
                throw new ClienteYaAgendado(
                    'cliente ya tenía el máximo de citas; marcado scheduled sin fecha/hora',
                );
            }

            const ok = primeroVisible(selOk);
            if (ok) {
                if (limiteAyuda) pararAlarma();
                await marcarAgendado();
                clicar(resolverObjetivo(ok));
                log('   cita confirmada (ModalInfoCita)');
                await esperarSinCarga(8000, { lanzarSinCupo: false });
                await dormir(CONFIG.esperaTrasClicMs ?? 200);
                return true;
            }

            // Otro aviso (p. ej. la agenda ya no está disponible): se cierra y el
            // cliente sigue pendiente para el próximo reintento, sin alarma.
            const aviso = modalErrorInesperado();
            if (aviso) {
                if (limiteAyuda) pararAlarma();
                log(`   ModalError al agendar: ${aviso}`);
                await cerrarModalError();
                guardarEstado({ activo: true });
                refrescarBoton();
                throw new SinCupo(`al agendar: ${aviso}`);
            }

            if (!limiteAyuda) {
                if (Date.now() >= limite) {
                    limiteAyuda = Date.now() + CONFIG.faseFinal.esperaPersonaMs;
                    const motivo = 'Agendar cita no respondió';
                    pararAlarma();
                    alarma(motivo);
                    pintar(`${motivo}. Revisa la página; si confirmas la cita, el script la registra.`, true);
                    log(`pidiendo ayuda: ${motivo}`);
                }
            } else if (Date.now() >= limiteAyuda) {
                break;
            }

            await dormir(150);
        }
        pararAlarma();
        throw new Error('No apareció confirmación ni aviso de máximo de citas');
    }

    // ───────────────────────────── DETECCIÓN Y ALARMA ─────────────────────────

    // La disponibilidad ya no se deduce de un aviso: se comprueba llegando a una
    // fecha con horas libres. Este aviso solo sirve para distinguir "no hay nada"
    // de "el script se rompió" cuando el flujo se queda en el PasoUno.
    const avisoSinCupo = () => {
        const aviso = normalizar(CONFIG.textoSinCupo);
        if (!aviso) return pantallaOverlayVisible('ModalError');
        // Preferir el texto del ModalError visible; fallback al body por si el
        // overlay aún no flipó display pero el mensaje ya está en el DOM.
        if (pantallaOverlayVisible('ModalError')) {
            const modal = document.querySelector('div[nombrepantalla="ModalError"]');
            const texto = normalizar(modal ? modal.innerText : '');
            if (texto.includes(aviso)) return true;
        }
        return normalizar(document.body.innerText).includes(aviso);
    };

    function detener(mensaje) {
        guardarEstado({ activo: false, ejecutando: false, ultimo: mensaje });
        pintar(mensaje, true);
        refrescarBoton();
        alarma(mensaje);
    }

    // La alarma insiste hasta que alguien atienda, así que hay que poder pararla.
    let pararAlarma = () => {};

    function alarma(cuerpo) {
        const { bipsPorRafaga, segundosEntreRafagas, volumen } = CONFIG.alarma;
        const temporizadores = [];
        let ctx = null;

        // Título al instante: AHK busca "CUPOS" en la ventana (no esperar el interval).
        const original = document.title.includes('CUPOS') ? 'Agendamiento' : document.title;
        document.title = '*** CUPOS ***';
        let on = true;
        temporizadores.push(
            setInterval(() => {
                document.title = (on = !on) ? '*** CUPOS ***' : original;
            }, 800),
        );

        try {
            const AC = vistaPagina().AudioContext || vistaPagina().webkitAudioContext;
            ctx = new AC();
            // Tras soft-retries largos Chrome deja el contexto suspendido.
            const intentarResume = () => ctx && ctx.resume && ctx.resume().catch(() => {});
            intentarResume();
            if (ctx.state === 'suspended') {
                log(
                    'audio bloqueado por la política de autoplay del navegador; ' +
                        'quedan la notificación y el título CUPOS',
                );
                // Reintentar resume unas veces (a veces se libera solo).
                let intentos = 0;
                const idResume = setInterval(() => {
                    intentos += 1;
                    intentarResume();
                    if (!ctx || ctx.state === 'running' || intentos > 10) clearInterval(idResume);
                }, 1000);
                temporizadores.push(idResume);
            }

            const rafaga = () => {
                if (!ctx || ctx.state === 'closed') return;
                intentarResume();
                let t = ctx.currentTime;
                for (let i = 0; i < bipsPorRafaga; i++) {
                    const osc = ctx.createOscillator();
                    const gan = ctx.createGain();
                    osc.type = 'square';
                    osc.frequency.value = i % 2 ? 880 : 1245;
                    // Rampas cortas en vez de un valor fijo: a este volumen, cortar
                    // la onda en seco mete un chasquido en cada bip.
                    gan.gain.setValueAtTime(0, t);
                    gan.gain.linearRampToValueAtTime(volumen, t + 0.01);
                    gan.gain.setValueAtTime(volumen, t + 0.3);
                    gan.gain.linearRampToValueAtTime(0, t + 0.35);
                    osc.connect(gan).connect(ctx.destination);
                    osc.start(t);
                    osc.stop(t + 0.36);
                    t += 0.45;
                }
            };

            rafaga();
            temporizadores.push(setInterval(rafaga, segundosEntreRafagas * 1000));
        } catch (e) {
            log('sin audio: ' + e.message);
        }

        if (window.Notification && Notification.permission === 'granted') {
            new Notification('Cupo disponible', { body: cuerpo });
        }

        pararAlarma = () => {
            temporizadores.forEach(clearInterval);
            document.title = original;
            if (ctx) ctx.close().catch(() => {});
            pararAlarma = () => {};
        };
    }

    // ───────────────────────────────── CICLO ──────────────────────────────────

    function indicePasoCategoria() {
        const idx = CONFIG.pasos.findIndex((p) => p.sel && p.sel.includes('btnCategoria'));
        return idx >= 0 ? idx : 0;
    }

    function encontrarCategoria() {
        const sel = (CONFIG.reintento && CONFIG.reintento.selCategoria) || '';
        if (!sel) return null;
        return buscar(sel) || Array.from(document.querySelectorAll(sel)).find(visibleEnPantalla) || null;
    }

    function categoriaVisible() {
        return !!encontrarCategoria();
    }

    function inicioVisible() {
        return !!buscar('div[nombrecontrol="btnSolicitarCita"]');
    }

    // Cierra un ModalError residual sin lanzar SinCupo (evita abortar el soft-retry).
    async function descartarModalErrorSiHay() {
        const sel = CONFIG.sinEspecialidades && CONFIG.sinEspecialidades.selAceptar;
        if (!sel) return;
        const aceptar =
            Array.from(document.querySelectorAll(sel)).find(visibleEnPantalla) || document.querySelector(sel);
        if (!aceptar || !hayModalSinCupo()) return;
        log('   cerrando modal residual');
        clicar(resolverObjetivo(aceptar));
        await dormir(CONFIG.pausaEntrePasosMs);
        await esperarSinCarga(5000, { lanzarSinCupo: false });
    }

    // Prepara el DOM para reintentar sin recargar.
    // Devuelve 'categoria' | 'inicio' | null (null = no queda más que recargar).
    async function prepararReintentoSuave({ trasAgendar = false } = {}) {
        if (trasAgendar) {
            // Tras Aceptar la página vuelve sola al inicio; se le da un momento
            // para pintarlo antes de dar el DOM por perdido y recargar.
            await esperarSinCarga(10000, { lanzarSinCupo: false });
            await esperarCualquiera(['div[nombrecontrol="btnSolicitarCita"]'], 8000);
            if (inicioVisible()) return 'inicio';
        }
        await descartarModalErrorSiHay();
        if (categoriaVisible()) return 'categoria';

        const selAnt = (CONFIG.reintento && CONFIG.reintento.selAnterior) || '';
        const max = (CONFIG.reintento && CONFIG.reintento.intentosAnterior) || 6;
        for (let i = 0; i < max; i++) {
            const ant = selAnt
                ? buscar(selAnt) || Array.from(document.querySelectorAll(selAnt)).find(visibleEnPantalla)
                : null;
            if (!ant) break;
            log(`   Anterior (${i + 1}/${max}) para volver a categoría`);
            clicar(resolverObjetivo(ant));
            await esperarSinCarga(8000, { lanzarSinCupo: false });
            await dormir(CONFIG.esperaTrasClicMs ?? 200);
            await descartarModalErrorSiHay();
            if (categoriaVisible()) return 'categoria';
        }

        if (categoriaVisible()) return 'categoria';
        // Tras Aceptar el player a veces vuelve al inicio del flujo: seguir sin recargar.
        if (inicioVisible()) return 'inicio';
        return null;
    }

    function recargarInicio(motivo) {
        softSeguidos = 0;
        pararAlarma();
        log(motivo || 'recarga a inicio');
        guardarEstado({ ejecutando: false, reintentoSoft: false, proximo: Date.now() });
        location.href = CONFIG.urlInicio;
    }

    async function ejecutarCiclo(opts = {}) {
        const soft = !!opts.soft;
        const estado = guardarEstado({
            ejecutando: true,
            ciclos: (leerEstado().ciclos || 0) + 1,
            reintentoSoft: false,
        });
        pintar(`Ciclo ${estado.ciclos}${soft ? ' (suave)' : ''} en curso...`);

        let resultado;
        let exito = false;
        let esperaMs = intervaloMs();
        let fueSinCupo = false;
        try {
            let pasos = CONFIG.pasos;
            if (soft) {
                const desde = await prepararReintentoSuave({ trasAgendar: !!opts.trasAgendar });
                if (!desde) {
                    recargarInicio('reintento suave: DOM no recuperable → recarga');
                    return;
                }
                if (desde === 'categoria') {
                    pasos = CONFIG.pasos.slice(indicePasoCategoria());
                } else {
                    pasos = CONFIG.pasos;
                }
                log(`reintento suave desde: ${desde} → ${pasos[0].desc || pasos[0].sel}`);
            }

            const { clientes, confiable } = await sincronizarClientes();
            const pendientes = clientes.filter((c) => !c.scheduled);
            pintar(`Ciclo ${estado.ciclos}: ${pendientes.length} pendiente(s)...`);
            if (!pendientes.length) {
                // Solo si la Sheet respondió: si falló la red y la caché quedó vacía
                // o solo con agendados dudosos, no apagar el monitor como "fin de cola".
                if (confiable) throw new FinCola('Todos los clientes ya están agendados');
                throw new Error('sin pendientes en caché (la Sheet no confirmó el estado)');
            }

            // Tras el captcha la cita ya está a la vista: esos pasos insisten y
            // piden ayuda en vez de abortar el ciclo.
            let enFaseFinal = false;
            for (const paso of pasos) {
                log(`→ ${paso.desc || paso.sel}`);
                if (enFaseFinal) await ejecutarPasoFinal(paso);
                else await ejecutarPaso(paso);
                if (paso.accion === 'captcha') enFaseFinal = true;
            }
            resultado = 'cita agendada, revisa el navegador y el correo';
            exito = true;
            softSeguidos = 0;

            // detener() apagó el monitor al llegar al captcha para no recargar el
            // formulario. Con la cita ya hecha, si queda gente en la cola se enciende
            // otra vez; tras Aceptar la página vuelve sola al inicio, así que se
            // sigue sin recargar.
            if (seguirConSiguienteCliente(estado, resultado)) return;
            resultado = 'cita agendada. No quedan clientes pendientes';
        } catch (e) {
            pararAlarma();
            if (esBloqueoSeguridad(e)) return;
            if (esFinCola(e)) {
                softSeguidos = 0;
                guardarEstado({ activo: false, ejecutando: false, ultimo: e.message });
                pintar(e.message, true);
                refrescarBoton();
                return;
            }
            // Tope diario: ya se marcó scheduled en Sheet; mismo camino que éxito.
            if (esClienteYaAgendado(e)) {
                softSeguidos = 0;
                resultado = e.message;
                exito = true;
                if (seguirConSiguienteCliente(estado, resultado)) return;
                guardarEstado({ activo: false, ejecutando: false, ultimo: resultado });
                pintar(`Ciclo ${estado.ciclos}: ${resultado}. No quedan pendientes.`, true);
                refrescarBoton();
                return;
            }
            fueSinCupo = esSinCupo(e);
            resultado = fueSinCupo ? `sin cupo (${e.message})` : `falló: ${e.message}`;
            if (!fueSinCupo) softSeguidos = 0;
            log(`fin ciclo: ${resultado}${fueSinCupo ? ' [SinCupo→soft]' : ' [error→recarga]'}`);
        }

        // detener() apagó el monitor al haber fecha y hora, para no recargar el
        // formulario. Si el ciclo falló después, el cupo ya no sirve: se enciende
        // de nuevo y se reintenta. Si fue bien, se deja apagado (o lo reenciende
        // seguirConSiguienteCliente).
        if (!leerEstado().activo) {
            if (!exito) {
                guardarEstado({ activo: true, ejecutando: false });
                refrescarBoton();
            } else {
                pintar(`Ciclo ${estado.ciclos}: ${resultado}`, exito);
                return;
            }
        }

        const maxSoft = (CONFIG.reintento && CONFIG.reintento.softMaxSeguidos) || 8;
        let usarSoft = false;
        if (fueSinCupo) {
            softSeguidos += 1;
            if (softSeguidos > maxSoft) {
                softSeguidos = 0;
                usarSoft = false;
                log(`agotados ${maxSoft} reintentos suaves → recarga`);
            } else {
                usarSoft = true;
            }
        }

        const segundos = Math.round(esperaMs / 1000);
        const modo = usarSoft ? 'suave (sin recargar)' : 'con recarga';
        pintar(`Ciclo ${estado.ciclos}: ${resultado}. Reintento ${modo} en ${segundos} s.`);
        programarSiguiente(esperaMs, { soft: usarSoft });
    }

    // Tras agendar (o tras el aviso de que el cliente ya tenía cita) se enciende
    // de nuevo el monitor y se sigue sin recargar. Devuelve false si no quedan.
    function seguirConSiguienteCliente(estado, resultado) {
        if (!cargarClientes().some((c) => !c.scheduled)) return false;
        softSeguidos = 0;
        const segundos = CONFIG.segundosAntesDelSiguienteCliente;
        guardarEstado({ activo: true, ejecutando: false, ultimo: resultado });
        refrescarBoton();
        pintar(`Ciclo ${estado.ciclos}: ${resultado}. Siguiente cliente en ${segundos} s.`, true);
        programarSiguiente(segundos * 1000, { soft: true, trasAgendar: true });
        return true;
    }

    function programarSiguiente(esperaMs = intervaloMs(), { soft = false, trasAgendar = false } = {}) {
        guardarEstado({
            ejecutando: false,
            proximo: Date.now() + esperaMs,
            reintentoSoft: !!soft,
        });
        if (timerReintento) clearTimeout(timerReintento);
        timerReintento = setTimeout(() => {
            timerReintento = null;
            if (!leerEstado().activo) return;
            if (soft) {
                log('disparo reintento suave (sin location.href)');
                ejecutarCiclo({ soft: true, trasAgendar });
            } else {
                recargarInicio('disparo reintento con recarga');
            }
        }, esperaMs);
    }

    // ─────────────────────────────── PANEL / LOG ──────────────────────────────

    let $panel, $estado;
    let refrescarBoton = () => {};

    function log(msg) {
        console.log('[scheduler]', msg);
        try {
            const linea = `${new Date().toISOString()} ${msg}`;
            const prev = JSON.parse(localStorage.getItem(CLAVE_LOG) || '[]');
            const arr = Array.isArray(prev) ? prev : [];
            arr.push(linea);
            localStorage.setItem(CLAVE_LOG, JSON.stringify(arr.slice(-80)));
        } catch {
            /* ignore quota / JSON issues */
        }
    }

    function pintar(texto, exito = false) {
        if (!$estado) return;
        $estado.textContent = texto;
        $estado.style.color = exito ? '#0a0' : '#333';
        log(texto);
    }

    function crearPanel() {
        $panel = document.createElement('div');
        $panel.style.cssText =
            'position:fixed;z-index:999999;right:12px;bottom:12px;background:#fff;border:1px solid #999;' +
            'border-radius:8px;padding:10px 12px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);max-width:280px';

        const titulo = document.createElement('strong');
        titulo.textContent = 'Super Scheduler';

        $estado = document.createElement('div');
        $estado.style.margin = '6px 0';

        const botones = document.createElement('div');
        botones.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

        const boton = document.createElement('button');
        boton.style.cssText = 'cursor:pointer;padding:4px 10px;border:1px solid #666;border-radius:4px;background:#f3f3f3';

        const botonExportar = document.createElement('button');
        botonExportar.textContent = 'Exportar citas';
        botonExportar.style.cssText = boton.style.cssText;
        botonExportar.onclick = () => exportarCitas();

        const botonSheet = document.createElement('button');
        botonSheet.textContent = 'Sheet URL';
        botonSheet.style.cssText = boton.style.cssText;
        botonSheet.onclick = () => {
            const actual = urlSheet();
            const nueva = window.prompt('URL /exec del Apps Script (se guarda solo en este navegador):', actual);
            if (nueva === null) return;
            const limpia = nueva.trim();
            if (limpia) localStorage.setItem(CLAVE_SHEET_URL, limpia);
            else localStorage.removeItem(CLAVE_SHEET_URL);
            pintar(limpia ? 'URL de Sheet guardada en este navegador.' : 'URL de Sheet borrada.');
        };

        const selectCiudad = document.createElement('select');
        selectCiudad.style.cssText =
            'cursor:pointer;padding:4px 8px;border:1px solid #666;border-radius:4px;background:#f3f3f3;max-width:140px';
        const opcionVacia = document.createElement('option');
        opcionVacia.value = '';
        opcionVacia.textContent = 'Ciudad…';
        selectCiudad.appendChild(opcionVacia);
        for (const ciudad of CONFIG.sheet.ciudades || []) {
            const op = document.createElement('option');
            op.value = ciudad;
            op.textContent = ciudad;
            selectCiudad.appendChild(op);
        }
        selectCiudad.value = nombreHoja();
        if (nombreHoja() && selectCiudad.value !== nombreHoja()) {
            // Ciudad guardada que no está en la lista: se añade para no perderla.
            const opExtra = document.createElement('option');
            opExtra.value = nombreHoja();
            opExtra.textContent = nombreHoja();
            selectCiudad.appendChild(opExtra);
            selectCiudad.value = nombreHoja();
        }
        selectCiudad.onchange = () => {
            const limpia = selectCiudad.value.trim();
            if (limpia) localStorage.setItem(CLAVE_HOJA, limpia);
            else localStorage.removeItem(CLAVE_HOJA);
            pintar(limpia ? `Ciudad/hoja: ${limpia}` : 'Ciudad/hoja borrada.');
        };

        const selectIntervalo = document.createElement('select');
        selectIntervalo.style.cssText =
            'cursor:pointer;padding:4px 8px;border:1px solid #666;border-radius:4px;background:#f3f3f3;max-width:100px';
        selectIntervalo.title = 'Periodicidad entre reintentos';
        for (const segs of CONFIG.intervalosSegundos || [5, 15, 30, 45, 60]) {
            const op = document.createElement('option');
            op.value = String(segs);
            op.textContent = `${segs} s`;
            selectIntervalo.appendChild(op);
        }
        selectIntervalo.value = String(intervaloSegundos());
        selectIntervalo.onchange = () => {
            const segs = Number(selectIntervalo.value);
            localStorage.setItem(CLAVE_INTERVALO, String(segs));
            pintar(`Reintento cada ${segs} s.`);
            // Si hay una espera en curso, reprograma con el nuevo intervalo.
            const est = leerEstado();
            if (est.activo && !est.ejecutando && timerReintento) {
                clearTimeout(timerReintento);
                timerReintento = null;
                programarSiguiente(intervaloMs(), { soft: !!est.reintentoSoft });
            }
        };

        refrescarBoton = () => {
            boton.textContent = leerEstado().activo ? 'Detener' : 'Iniciar';
        };

        boton.onclick = async () => {
            if (leerEstado().activo) {
                if (timerReintento) {
                    clearTimeout(timerReintento);
                    timerReintento = null;
                }
                softSeguidos = 0;
                guardarEstado({ activo: false, reintentoSoft: false, proximo: 0 });
                pintar('Detenido.');
            } else {
                if (window.Notification && Notification.permission === 'default') await Notification.requestPermission();
                softSeguidos = 0;
                localStorage.removeItem(claveSync());
                guardarEstado({ activo: true, ciclos: 0, proximo: 0, reintentoSoft: false });
                pintar('Iniciando...');
                ejecutarCiclo();
            }
            refrescarBoton();
        };

        refrescarBoton();
        botones.append(boton, botonExportar, botonSheet, selectCiudad, selectIntervalo);
        $panel.append(titulo, $estado, botones);
        document.body.appendChild($panel);
    }

    // ────────────────────────────────── ARRANQUE ──────────────────────────────

    crearPanel();

    const estado = leerEstado();
    if (!estado.activo) {
        pintar('Inactivo. Pulsa Iniciar.');
    } else if (!estado.proximo || Date.now() >= estado.proximo) {
        // Tras una recarga de página el DOM del flujo no está: ciclo completo.
        ejecutarCiclo();
    } else {
        const resta = Math.max(0, estado.proximo - Date.now());
        const softPendiente = !!estado.reintentoSoft;
        pintar(
            `En espera: próximo intento ${softPendiente ? 'suave ' : ''}en ${Math.ceil(resta / 1000)} s.`,
        );
        if (timerReintento) clearTimeout(timerReintento);
        timerReintento = setTimeout(() => {
            timerReintento = null;
            if (!leerEstado().activo) return;
            // Soft: intentar reutilizar el DOM. Solo recargar si preparar falla.
            if (leerEstado().reintentoSoft) {
                log('arranque: reintento suave pendiente');
                ejecutarCiclo({ soft: true });
            } else {
                recargarInicio('arranque: reintento con recarga');
            }
        }, resta);
    }
})();

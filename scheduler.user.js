// ==UserScript==
// @name         Super Scheduler (sandbox)
// @namespace    super-scheduler
// @version      2.0.1-sandbox
// @description  [SANDBOX] Agendamiento DIAN solo por ValidadorValidar (Fechas/Horas/Reserva/Creo). Sin clics.
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
// sandbox = POST (nueva vía). master = oficial con clics (no tocar desde aquí).
//

(function () {
    'use strict';

    const CLIENTES_INICIALES = [];

    const CONFIG = {
        urlInicio: 'https://agendamiento.dian.gov.co',

        reintento: {
            softMaxSeguidos: 20,
            softMaxOpciones: [10, 20, 30, 50, 100],
        },

        validador: {
            url: '/Player.aspx/ValidadorValidar',
            nombre: 'ValidadorDatos.CitasWeb',
            recurso: 'CitasDIAN',
            // Devoluciones
            categoriaCodigo: '13',
            tipoEspecialidadVirtual: '2',
            timeoutMs: 30000,
            infoServicioWeb:
                'B6gSx1jrtrvdoc4pcVdirINR7P8xoQ5IklP9PrUAsdSdu1c9ImEmjsrph3zrOh2yK2z5itWhmB4PdKiUNylhmc7QST68YbrSbB7rlug+9ObO+ffBIbtuB6cLBt8jdJ5IoNOsM3N2DO3d6foQ/uT/NaynHzR/nuKnVHbpiQLJF2t7ee5AqkYf8QgWris6up9KXNUgOiu0H7+aHT5EQhhWTlC/PK4lCMRMRfhikcGgZNnQRnnf6EKbX/nT+47aVi7X5zgKiPkFAv3EtojQIpLPLKGBT4bOeEOH8HOcUh4waXoA94sYwTh3Qy44XCCf9cPiUUDIHmAON9flWg2DxgdR+3YTV+1KF1DlKJWccbLsT8/HAZ/RQuqZe5j+68FOooIco8PpHSoWeA06qhwM/sTkwQO0U5E769EJExRnVY/lPW0PS5ijcTmy9sisHimhjEZJ',
            blobEncriptado:
                'n6ch/SV/k+dI4u2UFdFZt/brXMA9zVn5kM201dC5IYv7J3PpQUXUWqySuM59vvO2Emx2PVFvYTtaJ7Rd6sSsRSlPtbn2zrNctjIsohWmnJHvHUPuBieiBA0jm0eX62xUQ+6BFWhtYjg1ePMyZSQYL79D2dZBRPWvmBFKvDrg50aJU/0Tsgpc2oALqH1hAXFJfBsx+jJJ6QvEZWmJH+3a/g==',
            direccionMascara: '********************',
            idTipoDocumento: '2',
        },

        sheet: {
            activo: true,
            url: '',
            hoja: '',
            ciudades: ['Bogota', 'Medellin', 'Cali', 'Bucaramanga', 'Manizales'],
            colas: ['A', 'B', 'C'],
            timeoutMs: 15000,
            refrescoSegundos: 60,
            edadMaximaCacheSegundos: 300,
            proteccionAgendadoMs: 10 * 60 * 1000,
        },

        intervaloSegundos: 30,
        intervalosSegundos: [5, 10, 15, 30, 45, 60],
        segundosAntesDelSiguienteCliente: 0,

        textosClienteConCita: [
            'El usuario excedió el número máximo de citas por día para el mismo servicio',
            'El usuario excedió el número máximo de citas solicitadas abiertas',
        ],

        alarma: {
            bipsPorRafaga: 3,
            segundosEntreRafagas: 4,
            volumen: 0.28,
        },

        // Una sola vez al agendar (distinto de la alarma urgente).
        sonidoExito: {
            notas: [523.25, 659.25, 783.99], // Do–Mi–Sol
            duracionNota: 0.16,
            gap: 0.04,
            tipo: 'triangle',
            volumen: 0.22,
        },
    };

    const CLAVE = 'ssMonitorState';
    const CLAVE_CLIENTES = 'ssMonitorClientes';
    const CLAVE_SHEET_URL = 'ssSheetUrl';
    const CLAVE_HOJA = 'ssSheetHoja';
    const CLAVE_COLA = 'ssSheetCola';
    const CLAVE_INTERVALO = 'ssIntervaloSegundos';
    const CLAVE_SOFT_MAX = 'ssSoftMaxSeguidos';
    const CLAVE_VALIDADOR_BLOB = 'ssValidadorBlob';
    const CLAVE_LOG = 'ssMonitorLog';

    let softSeguidos = 0;
    let timerReintento = null;
    let clienteActual = null;
    let configValidador = null;
    let origenBlobValidador = '';
    let hookValidadorListo = false;
    let refrescarEstadoBlob = () => {};
    let $panel = null;
    let $estado = null;
    let refrescarBoton = () => {};
    let pararSonido = () => {};
    let pararTitulo = () => {};

    const vistaPagina = () => (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
    const urlSheet = () => (CONFIG.sheet.url || localStorage.getItem(CLAVE_SHEET_URL) || '').trim();
    const nombreHoja = () => (CONFIG.sheet.hoja || localStorage.getItem(CLAVE_HOJA) || '').trim();
    const nombreCola = () => (localStorage.getItem(CLAVE_COLA) || '').trim();

    function intervaloSegundos() {
        const permitidos = CONFIG.intervalosSegundos || [5, 10, 15, 30, 45, 60];
        const guardado = Number(localStorage.getItem(CLAVE_INTERVALO));
        if (permitidos.includes(guardado)) return guardado;
        const def = Number(CONFIG.intervaloSegundos) || 30;
        return permitidos.includes(def) ? def : permitidos[0];
    }
    const intervaloMs = () => intervaloSegundos() * 1000;

    function softMaxSeguidos() {
        const rein = CONFIG.reintento || {};
        const permitidos = rein.softMaxOpciones || [10, 20, 30, 50, 100];
        const raw = localStorage.getItem(CLAVE_SOFT_MAX);
        if (raw === null || raw === '') {
            const def = Number(rein.softMaxSeguidos) || 20;
            return permitidos.includes(def) ? def : 20;
        }
        const guardado = Number(raw);
        if (permitidos.includes(guardado)) return guardado;
        const def = Number(rein.softMaxSeguidos) || 20;
        return permitidos.includes(def) ? def : 20;
    }

    const claveClientes = () => {
        const hoja = nombreHoja();
        if (!hoja) return CLAVE_CLIENTES;
        const cola = nombreCola();
        return cola ? `${CLAVE_CLIENTES}:${hoja}:${cola}` : `${CLAVE_CLIENTES}:${hoja}`;
    };

    const claveSync = () => {
        const hoja = nombreHoja();
        const cola = nombreCola();
        return cola ? `ssSheetSyncAt:${hoja}:${cola}` : `ssSheetSyncAt:${hoja}`;
    };

    function normalizarTipoPersonaCliente(v) {
        const s = String(v == null ? '' : v)
            .trim()
            .toLowerCase();
        if (s === '2' || s.includes('jurid') || s.includes('juríd')) return '2';
        return '1';
    }

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

    function parseCiudadTramite(raw) {
        if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
        const s = String(raw == null ? '' : raw).trim();
        if (!s) return '';
        if (s.startsWith('[')) {
            try {
                const arr = JSON.parse(s);
                if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
            } catch {
                /* texto */
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
            tipoPersona: normalizarTipoPersonaCliente(c.tipoPersona),
            scheduled,
            nombre: String(c.nombre || c.name || '').trim(),
            apellido: String(c.apellido || '').trim(),
            email: String(c.email || c.correo || '').trim(),
            celular: String(c.celular || c.phone || '').trim(),
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
                        return {
                            ...c,
                            scheduled: true,
                            cita: previo.cita,
                            nombre: c.nombre || previo.nombre,
                            apellido: c.apellido || previo.apellido,
                            email: c.email || previo.email,
                            celular: c.celular || previo.celular,
                        };
                    }
                    return c;
                }
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
        const cola = nombreCola();
        if (cola) qs.set('cola', cola);
        return gmRequest({ method: 'GET', url: url + sep + qs.toString() }).then((data) => {
            const arr = Array.isArray(data) ? data : data && data.clientes;
            if (!Array.isArray(arr)) throw new Error('la respuesta no trae un arreglo de clientes');
            return arr.map(normalizarClienteRemoto).filter(Boolean);
        });
    }

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
            if (!data || data.ok === false) {
                throw new Error((data && data.error) || 'la Sheet rechazó la actualización');
            }
            return data;
        });
    }

    let refrescoEnCurso = false;
    function refrescarSheetEnFondo() {
        if (refrescoEnCurso) return;
        refrescoEnCurso = true;
        pedirClientesSheet()
            .then((remotos) => {
                if (!remotos.length) return;
                fusionarClientes(remotos, { sheetManda: true });
                localStorage.setItem(claveSync(), String(Date.now()));
                log(
                    `Sheet refrescada (${remotos.filter((c) => !c.scheduled).length} pendiente(s))`,
                );
            })
            .catch((e) => log('Sheet fondo: ' + e.message))
            .finally(() => {
                refrescoEnCurso = false;
            });
    }

    async function sincronizarClientes() {
        const { activo, edadMaximaCacheSegundos, refrescoSegundos } = CONFIG.sheet;
        if (!activo) {
            if (CLIENTES_INICIALES.length) fusionarClientes(CLIENTES_INICIALES);
            return cargarClientes();
        }
        const cache = cargarClientes();
        const syncAt = Number(localStorage.getItem(claveSync()) || 0);
        const edad = syncAt ? Date.now() - syncAt : Infinity;
        if (cache.some((c) => !c.scheduled) && edad < edadMaximaCacheSegundos * 1000) {
            if (edad >= refrescoSegundos * 1000) refrescarSheetEnFondo();
            return cache;
        }
        try {
            const remotos = await pedirClientesSheet();
            localStorage.setItem(claveSync(), String(Date.now()));
            return fusionarClientes(remotos.length ? remotos : CLIENTES_INICIALES, {
                sheetManda: !!remotos.length,
            });
        } catch (e) {
            log('Sheet sync falló: ' + e.message);
            if (cache.length) return cache;
            if (CLIENTES_INICIALES.length) return fusionarClientes(CLIENTES_INICIALES);
            throw e;
        }
    }

    function clienteListoParaPost(c) {
        if (!c || c.scheduled) return false;
        if (!c.nombre || !c.apellido || !c.email || !c.celular) return false;
        return true;
    }

    function textoCiudadPreferida(cliente) {
        const ct = cliente && cliente.ciudadTramite;
        if (Array.isArray(ct)) return ct[0] || '';
        return String(ct || '');
    }

    // ─── Blob / Validador ────────────────────────────────────────────────────

    function extraerObjetoBalanceado(texto, desde) {
        if (!texto || texto[desde] !== '{') return null;
        let profundidad = 0;
        let enString = false;
        let escape = false;
        let comilla = '';
        for (let i = desde; i < texto.length; i++) {
            const ch = texto[i];
            if (enString) {
                if (escape) {
                    escape = false;
                    continue;
                }
                if (ch === '\\') {
                    escape = true;
                    continue;
                }
                if (ch === comilla) enString = false;
                continue;
            }
            if (ch === '"' || ch === "'") {
                enString = true;
                comilla = ch;
                continue;
            }
            if (ch === '{') profundidad++;
            else if (ch === '}') {
                profundidad--;
                if (profundidad === 0) return texto.slice(desde, i + 1);
            }
        }
        return null;
    }

    function parseTextoBlobValidador(texto) {
        const raw = String(texto || '').trim();
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (_) {
            /* seguir */
        }
        const idxCfg = raw.search(/configuracion\s*:/);
        if (idxCfg >= 0) {
            const despues = raw.slice(idxCfg).search(/\{/);
            if (despues >= 0) {
                const bloque = extraerObjetoBalanceado(raw, idxCfg + despues);
                if (bloque) {
                    try {
                        return JSON.parse(bloque);
                    } catch (_) {
                        /* seguir */
                    }
                }
            }
        }
        try {
            const approx = raw
                .replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
                .replace(/'/g, '"');
            return JSON.parse(approx);
        } catch (_) {
            return null;
        }
    }

    function normalizarConfigValidador(data) {
        if (!data || typeof data !== 'object') return null;
        if (data.configuracion && typeof data.configuracion === 'object') data = data.configuracion;
        else if (typeof data.configuracion === 'string') {
            try {
                data = JSON.parse(data.configuracion);
            } catch (_) {
                return null;
            }
        }
        if (
            data &&
            typeof data.ConfiguracionServicioRestEncriptado === 'string' &&
            data.ConfiguracionServicioRestEncriptado.length > 20
        ) {
            return data;
        }
        return null;
    }

    function persistirConfigValidador(cfg, origen) {
        const norm = normalizarConfigValidador(cfg);
        if (!norm) return false;
        configValidador = norm;
        origenBlobValidador = origen || origenBlobValidador || 'hook';
        try {
            localStorage.setItem(CLAVE_VALIDADOR_BLOB, JSON.stringify(norm));
        } catch (_) {
            /* quota */
        }
        try {
            refrescarEstadoBlob();
        } catch (_) {
            /* panel */
        }
        return true;
    }

    function cargarBlobValidadorGuardado() {
        try {
            const raw = localStorage.getItem(CLAVE_VALIDADOR_BLOB);
            if (!raw) return null;
            return normalizarConfigValidador(JSON.parse(raw));
        } catch (_) {
            return null;
        }
    }

    function borrarBlobValidador() {
        configValidador = null;
        origenBlobValidador = '';
        try {
            localStorage.removeItem(CLAVE_VALIDADOR_BLOB);
        } catch (_) {
            /* ignore */
        }
        refrescarEstadoBlob();
    }

    function etiquetaOrigenBlob() {
        if (configValidadorLista()) {
            if (origenBlobValidador === 'pegado') return 'Blob: pegado';
            if (origenBlobValidador === 'hook') return 'Blob: hook';
            if (origenBlobValidador === 'fallback') return 'Blob: fallback';
            return 'Blob: guardado';
        }
        return 'Blob: no';
    }

    function guardarConfigSiValidador(url, body) {
        try {
            if (!url || String(url).indexOf('ValidadorValidar') < 0) return;
            let raw = body;
            if (raw && typeof raw !== 'string') {
                if (typeof URLSearchParams !== 'undefined' && raw instanceof URLSearchParams) {
                    raw = raw.toString();
                } else if (typeof raw === 'object') {
                    if (persistirConfigValidador(raw, 'hook')) return;
                    raw = JSON.stringify(raw);
                } else raw = String(raw);
            }
            if (!raw) return;
            persistirConfigValidador(JSON.parse(raw), 'hook');
        } catch (_) {
            /* ignore */
        }
    }

    function instalarHookValidador() {
        if (hookValidadorListo) return;
        const win = vistaPagina();
        try {
            const XO = win.XMLHttpRequest;
            if (XO && XO.prototype) {
                const open = XO.prototype.open;
                const send = XO.prototype.send;
                XO.prototype.open = function (method, url) {
                    this.__ssUrl = url;
                    return open.apply(this, arguments);
                };
                XO.prototype.send = function (body) {
                    guardarConfigSiValidador(this.__ssUrl, body);
                    return send.apply(this, arguments);
                };
            }
        } catch (_) {
            /* ignore */
        }
        try {
            if (typeof win.fetch === 'function') {
                const origFetch = win.fetch.bind(win);
                win.fetch = function (input, init) {
                    try {
                        const url = typeof input === 'string' ? input : input && input.url;
                        guardarConfigSiValidador(url, init && init.body);
                    } catch (_) {
                        /* ignore */
                    }
                    return origFetch(input, init);
                };
            }
        } catch (_) {
            /* ignore */
        }
        try {
            const jq = win.jQuery || win.$;
            if (jq && typeof jq.ajaxPrefilter === 'function') {
                jq.ajaxPrefilter((options) => {
                    try {
                        guardarConfigSiValidador(options && options.url, options && options.data);
                    } catch (_) {
                        /* ignore */
                    }
                });
            }
        } catch (_) {
            /* ignore */
        }
        hookValidadorListo = true;
    }

    function asegurarBlobFallback() {
        const enc = String((CONFIG.validador && CONFIG.validador.blobEncriptado) || '').trim();
        if (enc.length < 20) return null;
        const minimo = {
            ConfiguracionServicioRestEncriptado: enc,
            ControlesGeolocalizacion: [],
            FormatoCitas:
                '{cita.codigo}    {cita.fecha}    {cita.Oficina.Nombre}    img/icono1.png    img/icono2.png    img/icono3.png',
            IdPais: 1,
            DistanciaMinima: 0,
            TopOficinasCercanas: 0,
            FormatoEncabezadoOficina: '',
            FormatoOficina: '{0}',
            ModoWebPlayer: true,
            TipoPolitica: 0,
            ObtenerEspecialidadesVirtuales: false,
            ObtenerEspecialidadesPresenciales: false,
            GenerarTurno: false,
        };
        persistirConfigValidador(minimo, 'fallback');
        return configValidador;
    }

    function configValidadorLista() {
        instalarHookValidador();
        if (configValidador && configValidador.ConfiguracionServicioRestEncriptado) return true;
        const guardado = cargarBlobValidadorGuardado();
        if (guardado) {
            configValidador = guardado;
            if (!origenBlobValidador) origenBlobValidador = 'guardado';
            return true;
        }
        return !!asegurarBlobFallback();
    }

    function asegurarConfigValidador() {
        if (configValidadorLista()) return configValidador;
        return null;
    }

    function plantillaCita(tipoCliente, tipoEspecialidad) {
        const virtual = String(tipoEspecialidad || '0') === '2';
        return {
            CodigoCita: null,
            CodigoCitaModificada: null,
            Cola: { IdEspecialidad: '0', Nombre: null },
            TipoEspecialidad: {
                IdTipoEspecialidad: virtual ? 2 : Number(tipoEspecialidad) || 0,
                Nombre: virtual ? 'Virtual' : null,
            },
            Oficina: {
                IdOficina: virtual ? '001' : 0,
                Nombre: null,
                Latitud: 0,
                Longitud: 0,
            },
            UsuarioCliente: {
                IdTipoCliente: String(tipoCliente || '1'),
                IdTipoDocumento: 0,
                Nombre: null,
                Apellido: null,
                NumeroDocumento: null,
                CorreoElectronico: null,
                Celular: null,
                Telefono: null,
                Direccion: null,
                IdCiudad: 0,
                IdEstado: 0,
                AceptaPoliticaDatos: false,
            },
            Fecha: '2001-01-01T17:00:00.000Z',
            Hora: '2001-01-01T17:00:00.000Z',
            IdAgenda: 0,
            Estado: { IdEstado: 0, Nombre: null },
            Funcionario: { NombreAMostrar: null, Id: null },
            Archivo: null,
            CamposAdicionales: null,
            EsFlujoCitaCreacion: 'true',
        };
    }

    function parseRespuestaValidador(data) {
        if (data == null) return null;
        if (typeof data === 'string') {
            try {
                return JSON.parse(data);
            } catch (_) {
                return null;
            }
        }
        if (typeof data.d === 'string') {
            try {
                return JSON.parse(data.d);
            } catch (_) {
                return data;
            }
        }
        if (data.d && typeof data.d === 'object') return data.d;
        return data;
    }

    async function postValidadorValidar(respuestaBase, opts = {}) {
        const cfg = CONFIG.validador || {};
        const configuracion = opts.configuracion || asegurarConfigValidador();
        if (!configuracion) throw new Error('sin blob del Validador');

        const win = vistaPagina();
        const jq = win.jQuery || win.$;
        if (!jq || typeof jq.ajax !== 'function') {
            throw new Error('jQuery no disponible en la página');
        }

        const nombre = opts.nombre || cfg.nombre || 'ValidadorDatos.CitasWeb';
        const url = (cfg.url || 'Player.aspx/ValidadorValidar').replace(/^\//, '');
        const data =
            "{nombre:'" +
            nombre +
            "',configuracion:" +
            JSON.stringify(configuracion) +
            ', respuestaBase: ' +
            JSON.stringify(respuestaBase) +
            '}';

        const timeoutMs = cfg.timeoutMs || 30000;
        return await new Promise((resolve, reject) => {
            let listo = false;
            const timer = setTimeout(() => {
                if (listo) return;
                listo = true;
                reject(new Error('Validador timeout'));
            }, timeoutMs);

            jq.ajax({
                url,
                type: 'POST',
                data,
                contentType: 'application/json; charset=UTF-8',
                dataType: 'json',
                success: (d) => {
                    if (listo) return;
                    listo = true;
                    clearTimeout(timer);
                    try {
                        const parsed = parseRespuestaValidador(d);
                        if (!parsed) reject(new Error('Validador: respuesta vacía'));
                        else resolve(parsed);
                    } catch (e) {
                        reject(e);
                    }
                },
                error: (xhr) => {
                    if (listo) return;
                    listo = true;
                    clearTimeout(timer);
                    const status = xhr && xhr.status;
                    const body = (xhr && xhr.responseText) || '';
                    reject(
                        new Error(
                            'Validador HTTP ' +
                                status +
                                (body ? ' ' + String(body).slice(0, 120) : ''),
                        ),
                    );
                },
            });
        });
    }

    function deserializarObjValidador(valor) {
        let v = valor;
        if (typeof v === 'string') {
            try {
                v = JSON.parse(v);
            } catch (_) {
                return null;
            }
        }
        return v;
    }

    function listaDesdeObjetosEncontrados(resp) {
        const objs = resp && resp.ObjetosEncontrados;
        if (!Array.isArray(objs) || !objs.length) return [];
        let first = deserializarObjValidador(objs[0]);
        if (first == null) return [];
        if (Array.isArray(first) && first.length && Array.isArray(first[0])) first = first[0];
        return Array.isArray(first) ? first : [first];
    }

    function fechaIsoParaHoras(iso) {
        const s = String(iso || '');
        if (/T00:00:00(\.000)?Z$/i.test(s)) {
            return s.replace(/T00:00:00(\.000)?Z$/i, 'T05:00:00.000Z');
        }
        return s;
    }

    function tokenInfo() {
        return String((CONFIG.validador && CONFIG.validador.infoServicioWeb) || '').trim();
    }

    function normalizarTextoMatch(s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    async function resolverColaPorTramite(cliente) {
        const cfg = CONFIG.validador || {};
        const recurso = cfg.recurso || 'CitasDIAN';
        const tipo = String(cliente.tipoPersona || '1');
        const tipoVirt = String(cfg.tipoEspecialidadVirtual || '2');
        const codCat = String(cfg.categoriaCodigo || '13');
        const preferida = textoCiudadPreferida(cliente);
        const preferidas = Array.isArray(cliente.ciudadTramite)
            ? cliente.ciudadTramite
            : [preferida];

        const r = await postValidadorValidar({
            Fuente: 'Validador',
            Encontrado: false,
            DetalleAdicional: 'manejadorEncontroColas',
            ObjetosEncontrados: [
                JSON.stringify(plantillaCita(tipo, tipoVirt)),
                'Nombre',
                tipo,
                codCat,
                tipoVirt,
            ],
            Recurso: recurso,
        });

        if (!r.Encontrado) {
            throw new SinCupo('Validador: sin colas (' + (r.DetalleAdicional || '') + ')');
        }

        const colas = listaDesdeObjetosEncontrados(r).filter((c) => c && c.IdEspecialidad);
        if (!colas.length) throw new SinCupo('Validador: lista de colas vacía');

        for (const pref of preferidas) {
            const nPref = normalizarTextoMatch(pref);
            if (!nPref) continue;
            const hit = colas.find((c) => normalizarTextoMatch(c.Nombre) === nPref);
            if (hit) {
                return { IdEspecialidad: hit.IdEspecialidad, Nombre: hit.Nombre };
            }
        }
        for (const pref of preferidas) {
            const nPref = normalizarTextoMatch(pref);
            if (!nPref || nPref.length < 8) continue;
            const hit = colas.find((c) => {
                const n = normalizarTextoMatch(c.Nombre);
                return n.includes(nPref) || nPref.includes(n);
            });
            if (hit) {
                return { IdEspecialidad: hit.IdEspecialidad, Nombre: hit.Nombre };
            }
        }

        throw new SinCupo(
            'ninguna cola coincide con ciudadTramite: ' + preferidas.join(' | '),
        );
    }

    async function consultarFechasHoras(cola, tipoCliente) {
        const cfg = CONFIG.validador || {};
        const recurso = cfg.recurso || 'CitasDIAN';
        const token = tokenInfo();
        const tipoVirt = String(cfg.tipoEspecialidadVirtual || '2');
        const tipo = String(tipoCliente || '1');

        const citaFechas = plantillaCita(tipo, tipoVirt);
        citaFechas.Cola = {
            IdEspecialidad: Number(cola.IdEspecialidad),
            Nombre: cola.Nombre || null,
        };

        const rFechas = await postValidadorValidar({
            Fuente: 'Validador',
            Encontrado: false,
            DetalleAdicional: 'manejadorEncontroFechas',
            ObjetosEncontrados: [JSON.stringify(citaFechas), token, true],
            Recurso: recurso,
        });
        if (!rFechas.Encontrado) {
            throw new SinCupo('Fechas: ' + (rFechas.DetalleAdicional || 'sin cupo'));
        }

        const fechas = listaDesdeObjetosEncontrados(rFechas)
            .map((x) => (typeof x === 'string' ? x : x && x.Fecha))
            .filter(Boolean);
        if (!fechas.length) throw new SinCupo('Fechas vacías');

        const fechaElegida = fechaIsoParaHoras(fechas[0]);
        const citaHoras = plantillaCita(tipo, tipoVirt);
        citaHoras.Cola = citaFechas.Cola;
        citaHoras.Fecha = fechaElegida;

        const rHoras = await postValidadorValidar({
            Fuente: 'Validador',
            Encontrado: false,
            DetalleAdicional: 'manejadorEncontroHoras',
            ObjetosEncontrados: [JSON.stringify(citaHoras)],
            Recurso: recurso,
        });
        if (!rHoras.Encontrado) {
            throw new SinCupo('Horas: ' + (rHoras.DetalleAdicional || 'sin cupo'));
        }

        const slots = listaDesdeObjetosEncontrados(rHoras).filter(
            (h) => h && h.IdentificadoresAgendas && h.HoraAgenda,
        );
        if (!slots.length) throw new SinCupo('sin horas disponibles');

        return { fechas, fechaConsultada: fechaElegida, slots };
    }

    function usuarioDesdeCliente(cliente) {
        const cfg = CONFIG.validador || {};
        return {
            IdTipoCliente: String(cliente.tipoPersona || '1'),
            IdTipoDocumento: String(cfg.idTipoDocumento || '2'),
            Nombre: String(cliente.nombre || ''),
            Apellido: String(cliente.apellido || ''),
            NumeroDocumento: String(cliente.cedula || '').replace(/\D/g, ''),
            CorreoElectronico: String(cliente.email || ''),
            Celular: String(cliente.celular || ''),
            Telefono: null,
            Direccion: String(cfg.direccionMascara || '********************'),
            IdCiudad: 0,
            IdEstado: 0,
            AceptaPoliticaDatos: true,
        };
    }

    async function reservarYCrear(cliente, cola, fechaIso, slot) {
        const cfg = CONFIG.validador || {};
        const recurso = cfg.recurso || 'CitasDIAN';
        const token = tokenInfo();
        const tipoVirt = String(cfg.tipoEspecialidadVirtual || '2');
        const cita = plantillaCita(cliente.tipoPersona || '1', tipoVirt);
        cita.Cola = {
            IdEspecialidad: Number(cola.IdEspecialidad),
            Nombre: cola.Nombre || null,
        };
        cita.Fecha = fechaIso;
        cita.Hora = slot.HoraAgenda;
        cita.IdAgenda = slot.IdentificadoresAgendas;
        cita.UsuarioCliente = usuarioDesdeCliente(cliente);

        const rReserva = await postValidadorValidar({
            Fuente: 'Validador',
            Encontrado: false,
            DetalleAdicional: 'manejadorReservaAgenda',
            ObjetosEncontrados: [JSON.stringify(cita), token, true],
            Recurso: recurso,
        });
        if (!rReserva.Encontrado) {
            const err =
                rReserva.ErrorString ||
                rReserva.MensajeAdicional ||
                rReserva.DetalleAdicional ||
                'Reserva falló';
            if (/máximo de citas|maximo de citas|excedió/i.test(String(err))) {
                throw new ClienteConCita(err);
            }
            throw new Error('Reserva: ' + err);
        }

        const reservaObj = deserializarObjValidador(
            (rReserva.ObjetosEncontrados && rReserva.ObjetosEncontrados[0]) || null,
        );
        if (reservaObj && reservaObj.AgendaDisponibleId) {
            cita.IdAgenda = reservaObj.AgendaDisponibleId;
        }

        const rCreo = await postValidadorValidar({
            Fuente: 'Validador',
            Encontrado: false,
            DetalleAdicional: 'manejadorCreoCita',
            ObjetosEncontrados: [JSON.stringify(cita), token, true],
            Recurso: recurso,
        });
        if (!rCreo.Encontrado) {
            const err =
                rCreo.ErrorString ||
                rCreo.MensajeAdicional ||
                rCreo.DetalleAdicional ||
                'CreoCita falló';
            if (/máximo de citas|maximo de citas|excedió/i.test(String(err))) {
                throw new ClienteConCita(err);
            }
            throw new Error('CreoCita: ' + err);
        }

        const objs = Array.isArray(rCreo.ObjetosEncontrados) ? rCreo.ObjetosEncontrados : [];
        return {
            codigoCita: objs[0],
            idInterno: objs[1],
            fecha: fechaIso,
            hora: slot.Contenido || slot.HoraAgenda,
            idAgenda: cita.IdAgenda,
        };
    }

    // ─── Errores de control ──────────────────────────────────────────────────

    function SinCupo(msg) {
        this.name = 'SinCupo';
        this.message = msg || 'sin cupo';
    }
    SinCupo.prototype = Object.create(Error.prototype);

    function ClienteConCita(msg) {
        this.name = 'ClienteConCita';
        this.message = msg || 'cliente con cita';
    }
    ClienteConCita.prototype = Object.create(Error.prototype);

    function FinCola(msg) {
        this.name = 'FinCola';
        this.message = msg || 'cola vacía';
    }
    FinCola.prototype = Object.create(Error.prototype);

    function esSinCupo(e) {
        return e && (e.name === 'SinCupo' || e instanceof SinCupo);
    }
    function esClienteConCita(e) {
        return e && (e.name === 'ClienteConCita' || e instanceof ClienteConCita);
    }
    function esFinCola(e) {
        return e && (e.name === 'FinCola' || e instanceof FinCola);
    }

    // ─── Agendado / alarma ───────────────────────────────────────────────────

    async function marcarAgendado({ date, hour, name, email } = {}) {
        const clientes = cargarClientes();
        const cedula = clienteActual && clienteActual.cedula;
        if (cedula == null) return;
        const idx = clientes.findIndex((c) => String(c.cedula) === String(cedula));
        if (idx < 0) return;
        const prev = clientes[idx];
        clientes[idx] = {
            ...prev,
            scheduled: true,
            cita: {
                fecha: date || '',
                hora: hour || '',
                tramite: textoCiudadPreferida(prev),
                agendadoEn: new Date().toISOString(),
            },
            name: name || prev.nombre,
            email: email || prev.email,
        };
        guardarClientes(clientes);
        if (CONFIG.sheet.activo && urlSheet()) {
            try {
                await actualizarClienteSheet({
                    cedula,
                    date: date || '',
                    hour: hour || '',
                    name: name || prev.nombre || '',
                    email: email || prev.email || '',
                    scheduled: true,
                });
            } catch (e) {
                log('Sheet schedule falló: ' + e.message);
            }
        }
    }

    function detener(mensaje, opts = {}) {
        guardarEstado({ activo: false, ejecutando: false, ultimo: mensaje });
        pintar(mensaje, true);
        refrescarBoton();
        alarma(mensaje, opts);
    }

    function pararAlarma() {
        pararSonido();
        pararTitulo();
    }

    /** Arpegio Do–Mi–Sol una sola vez (éxito de cita). */
    function tocarSonidoExito() {
        const cfg = CONFIG.sonidoExito || {};
        const notas = cfg.notas || [523.25, 659.25, 783.99];
        const dur = Number(cfg.duracionNota) || 0.16;
        const gap = Number(cfg.gap) || 0.04;
        const vol = Number(cfg.volumen) || 0.22;
        const tipo = cfg.tipo || 'triangle';
        pararSonido();
        let ctx = null;
        try {
            const AC = vistaPagina().AudioContext || vistaPagina().webkitAudioContext;
            ctx = new AC();
            if (ctx.resume) ctx.resume().catch(() => {});
            let t = ctx.currentTime;
            for (let i = 0; i < notas.length; i++) {
                const osc = ctx.createOscillator();
                const gan = ctx.createGain();
                osc.type = tipo;
                osc.frequency.value = notas[i];
                gan.gain.setValueAtTime(0, t);
                gan.gain.linearRampToValueAtTime(vol, t + 0.015);
                gan.gain.setValueAtTime(vol, t + dur * 0.7);
                gan.gain.linearRampToValueAtTime(0, t + dur);
                osc.connect(gan).connect(ctx.destination);
                osc.start(t);
                osc.stop(t + dur + 0.02);
                t += dur + gap;
            }
            const cierreMs = (notas.length * (dur + gap) + 0.4) * 1000;
            const tid = setTimeout(() => {
                if (ctx) ctx.close().catch(() => {});
                pararSonido = () => {};
            }, cierreMs);
            pararSonido = () => {
                clearTimeout(tid);
                if (ctx) ctx.close().catch(() => {});
                pararSonido = () => {};
            };
        } catch (e) {
            log('sin audio éxito: ' + e.message);
        }
    }

    /** Notifica cita agendada: título + sonido victoria (sin loop). */
    function celebracionExito(cuerpo) {
        pararTitulo();
        const original = document.title.includes('CUPOS')
            ? 'Agendamiento'
            : document.title.includes('CITA OK')
              ? 'Agendamiento'
              : document.title;
        document.title = '*** CITA OK ***';
        let on = true;
        const idTitulo = setInterval(() => {
            document.title = (on = !on) ? '*** CITA OK ***' : original;
        }, 900);
        pararTitulo = () => {
            clearInterval(idTitulo);
            document.title = original;
            pararTitulo = () => {};
        };
        tocarSonidoExito();
        if (window.Notification && Notification.permission === 'granted') {
            new Notification('Cita agendada', { body: cuerpo });
        }
    }

    /** Alarma urgente (bips en loop). No usar para éxito de cita. */
    function alarma(cuerpo, opts = {}) {
        const conSonido = opts.sonido !== false;
        const conTitulo = opts.titulo !== false;
        const { bipsPorRafaga, segundosEntreRafagas, volumen } = CONFIG.alarma;

        if (conTitulo) {
            pararTitulo();
            const original = document.title.includes('CUPOS') ? 'Agendamiento' : document.title;
            document.title = '*** CUPOS ***';
            let on = true;
            const idTitulo = setInterval(() => {
                document.title = (on = !on) ? '*** CUPOS ***' : original;
            }, 800);
            pararTitulo = () => {
                clearInterval(idTitulo);
                document.title = original;
                pararTitulo = () => {};
            };
        }

        if (!conSonido) return;
        pararSonido();
        const temporizadores = [];
        let ctx = null;
        try {
            const AC = vistaPagina().AudioContext || vistaPagina().webkitAudioContext;
            ctx = new AC();
            const intentarResume = () => ctx && ctx.resume && ctx.resume().catch(() => {});
            intentarResume();
            const rafaga = () => {
                if (!ctx || ctx.state === 'closed') return;
                intentarResume();
                let t = ctx.currentTime;
                for (let i = 0; i < bipsPorRafaga; i++) {
                    const osc = ctx.createOscillator();
                    const gan = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = i % 2 ? 740 : 980;
                    gan.gain.setValueAtTime(0, t);
                    gan.gain.linearRampToValueAtTime(volumen, t + 0.02);
                    gan.gain.setValueAtTime(volumen, t + 0.22);
                    gan.gain.linearRampToValueAtTime(0, t + 0.3);
                    osc.connect(gan).connect(ctx.destination);
                    osc.start(t);
                    osc.stop(t + 0.32);
                    t += 0.4;
                }
            };
            rafaga();
            temporizadores.push(setInterval(rafaga, segundosEntreRafagas * 1000));
        } catch (e) {
            log('sin audio: ' + e.message);
        }
        if (window.Notification && Notification.permission === 'granted') {
            new Notification('Scheduler', { body: cuerpo });
        }
        pararSonido = () => {
            temporizadores.forEach(clearInterval);
            if (ctx) ctx.close().catch(() => {});
            pararSonido = () => {};
        };
    }

    // ─── Ciclo POST ──────────────────────────────────────────────────────────

    function recargarInicio(motivo) {
        log('Recarga: ' + motivo);
        guardarEstado({ ejecutando: false, reintentoSoft: false });
        location.href = CONFIG.urlInicio;
    }

    function programarSiguiente(esperaMs = intervaloMs(), { soft = false } = {}) {
        if (timerReintento) clearTimeout(timerReintento);
        guardarEstado({
            activo: true,
            ejecutando: false,
            reintentoSoft: !!soft,
            proximo: Date.now() + esperaMs,
        });
        timerReintento = setTimeout(() => ejecutarCiclo({ soft }), esperaMs);
        pintar(
            soft
                ? `Reintento soft en ${Math.round(esperaMs / 1000)}s…`
                : `Siguiente ciclo en ${Math.round(esperaMs / 1000)}s…`,
        );
    }

    async function ejecutarCiclo() {
        const est = leerEstado();
        if (!est.activo) return;
        if (est.ejecutando) return;
        guardarEstado({ ejecutando: true, ciclos: (est.ciclos || 0) + 1 });
        pararAlarma();
        clienteActual = null;

        try {
            if (!configValidadorLista()) {
                throw new Error('sin blob Validador (pega en panel)');
            }
            if (!tokenInfo()) throw new Error('falta infoServicioWeb en CONFIG');

            pintar('Sincronizando Sheet…');
            const clientes = await sincronizarClientes();
            const pendientes = clientes.filter((c) => !c.scheduled);
            if (!pendientes.length) {
                detener('No hay clientes pendientes en la Sheet.', { sonido: false });
                return;
            }

            const listos = pendientes.filter(clienteListoParaPost);
            const sinPii = pendientes.length - listos.length;
            if (sinPii > 0) {
                log(`AVISO: ${sinPii} pendiente(s) sin nombre/apellido/email/celular enmascarados`);
            }
            if (!listos.length) {
                throw new SinCupo(
                    'ningún pendiente tiene PII enmascarada (nombre/apellido/email/celular)',
                );
            }

            const cliente = listos[0];
            clienteActual = cliente;
            log(
                `Cliente ${cliente.cedula} · ${cliente.nombre} ${cliente.apellido} · tipo=${cliente.tipoPersona}`,
            );

            pintar('Resolviendo cola (EncontroColas)…');
            const cola = await resolverColaPorTramite(cliente);
            log(`Cola IdEspecialidad=${cola.IdEspecialidad} · ${cola.Nombre}`);

            pintar('Consultando Fechas/Horas…');
            const { fechaConsultada, slots } = await consultarFechasHoras(
                cola,
                cliente.tipoPersona,
            );
            const slot = slots[0];
            log(
                `Slot ${slot.Contenido || slot.HoraAgenda} → ${slot.IdentificadoresAgendas} (${slots.length} disponibles)`,
            );

            pintar('Reserva → Creo…');
            const cita = await reservarYCrear(cliente, cola, fechaConsultada, slot);
            softSeguidos = 0;

            await marcarAgendado({
                date: cita.fecha,
                hour: cita.hora,
                name: `${cliente.nombre} ${cliente.apellido}`.trim(),
                email: cliente.email,
            });

            const msg = `Cita ${cita.codigoCita} · ${cita.hora} · ${cliente.cedula}`;
            log('OK ' + msg);
            celebracionExito(msg);

            const quedan = cargarClientes().filter((c) => !c.scheduled && clienteListoParaPost(c));
            if (quedan.length) {
                const espera = (CONFIG.segundosAntesDelSiguienteCliente || 0) * 1000;
                pintar(msg + ` · quedan ${quedan.length}`, true);
                programarSiguiente(Math.max(espera, 2000), { soft: false });
            } else {
                detener(msg + ' · cola completa', { sonido: false });
            }
        } catch (e) {
            if (esFinCola(e)) {
                detener(e.message, { sonido: false });
                return;
            }
            if (esClienteConCita(e)) {
                log('Cliente con cita: ' + e.message);
                await marcarAgendado({ date: '', hour: '' });
                softSeguidos = 0;
                programarSiguiente(1000, { soft: false });
                return;
            }
            if (esSinCupo(e)) {
                softSeguidos += 1;
                log(`Sin cupo (${softSeguidos}/${softMaxSeguidos()}): ${e.message}`);
                if (softSeguidos >= softMaxSeguidos()) {
                    softSeguidos = 0;
                    recargarInicio('soft máx sin cupo');
                    return;
                }
                programarSiguiente(intervaloMs(), { soft: true });
                return;
            }
            softSeguidos += 1;
            log(`Error ciclo (${softSeguidos}): ${(e && e.message) || e}`);
            if (softSeguidos >= softMaxSeguidos()) {
                softSeguidos = 0;
                recargarInicio('soft máx error');
                return;
            }
            programarSiguiente(intervaloMs(), { soft: true });
        } finally {
            guardarEstado({ ejecutando: false });
        }
    }

    // ─── Panel ───────────────────────────────────────────────────────────────

    function log(msg) {
        console.log('[scheduler]', msg);
        try {
            const linea = `${new Date().toISOString()} ${msg}`;
            const prev = JSON.parse(localStorage.getItem(CLAVE_LOG) || '[]');
            const arr = Array.isArray(prev) ? prev : [];
            arr.push(linea);
            localStorage.setItem(CLAVE_LOG, JSON.stringify(arr.slice(-80)));
        } catch {
            /* ignore */
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
            'border-radius:8px;padding:10px 12px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);max-width:340px';

        const titulo = document.createElement('strong');
        titulo.textContent = 'Super Scheduler · POST';

        $estado = document.createElement('div');
        $estado.style.margin = '6px 0';

        const botones = document.createElement('div');
        botones.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

        const estiloBtn =
            'cursor:pointer;padding:4px 10px;border:1px solid #666;border-radius:4px;background:#f3f3f3';

        const $blobEstado = document.createElement('div');
        $blobEstado.style.cssText = 'margin:4px 0 0;color:#555;font-size:11px';
        refrescarEstadoBlob = () => {
            $blobEstado.textContent = etiquetaOrigenBlob();
        };

        const bloqueBlob = document.createElement('div');
        bloqueBlob.style.cssText = 'display:none;margin-top:8px;';
        const areaBlob = document.createElement('textarea');
        areaBlob.placeholder = 'Pega Payload ValidadorValidar o configuracion JSON';
        areaBlob.style.cssText =
            'width:100%;min-height:72px;box-sizing:border-box;font:11px/1.3 ui-monospace,monospace;' +
            'border:1px solid #bbb;border-radius:4px;padding:4px;resize:vertical';
        const filaBlob = document.createElement('div');
        filaBlob.style.cssText = 'display:flex;gap:6px;margin-top:4px;flex-wrap:wrap';
        const btnGuardarBlob = document.createElement('button');
        btnGuardarBlob.textContent = 'Guardar blob';
        btnGuardarBlob.style.cssText = estiloBtn;
        btnGuardarBlob.onclick = () => {
            const parsed = parseTextoBlobValidador(areaBlob.value.trim());
            if (!parsed || !persistirConfigValidador(parsed, 'pegado')) {
                pintar('Blob inválido.');
                return;
            }
            areaBlob.value = '';
            bloqueBlob.style.display = 'none';
            pintar('Blob guardado.');
        };
        const btnBorrarBlob = document.createElement('button');
        btnBorrarBlob.textContent = 'Borrar blob';
        btnBorrarBlob.style.cssText = estiloBtn;
        btnBorrarBlob.onclick = () => {
            borrarBlobValidador();
            asegurarBlobFallback();
            pintar('Blob borrado (queda fallback si hay).');
        };
        filaBlob.append(btnGuardarBlob, btnBorrarBlob);
        bloqueBlob.append(areaBlob, filaBlob);

        const boton = document.createElement('button');
        boton.style.cssText = estiloBtn;
        const botonBlob = document.createElement('button');
        botonBlob.textContent = 'Blob…';
        botonBlob.style.cssText = estiloBtn;
        botonBlob.onclick = () => {
            const abierto = bloqueBlob.style.display !== 'none';
            bloqueBlob.style.display = abierto ? 'none' : 'block';
            if (!abierto) {
                const g = cargarBlobValidadorGuardado();
                areaBlob.value = g ? JSON.stringify(g) : '';
            }
        };

        const botonSheet = document.createElement('button');
        botonSheet.textContent = 'Sheet URL';
        botonSheet.style.cssText = estiloBtn;
        botonSheet.onclick = () => {
            const actual = urlSheet();
            const nueva = window.prompt('URL /exec Apps Script:', actual);
            if (nueva === null) return;
            const limpia = nueva.trim();
            if (limpia) localStorage.setItem(CLAVE_SHEET_URL, limpia);
            else localStorage.removeItem(CLAVE_SHEET_URL);
            pintar(limpia ? 'URL Sheet guardada.' : 'URL Sheet borrada.');
        };

        const selectCiudad = document.createElement('select');
        selectCiudad.style.cssText = estiloBtn + ';max-width:140px';
        selectCiudad.appendChild(new Option('Ciudad…', ''));
        for (const ciudad of CONFIG.sheet.ciudades || []) {
            selectCiudad.appendChild(new Option(ciudad, ciudad));
        }
        selectCiudad.value = nombreHoja();
        if (nombreHoja() && selectCiudad.value !== nombreHoja()) {
            selectCiudad.appendChild(new Option(nombreHoja(), nombreHoja()));
            selectCiudad.value = nombreHoja();
        }
        selectCiudad.onchange = () => {
            const v = selectCiudad.value.trim();
            if (v) localStorage.setItem(CLAVE_HOJA, v);
            else localStorage.removeItem(CLAVE_HOJA);
            pintar(v ? `Ciudad: ${v}` : 'Ciudad borrada.');
        };

        const selectCola = document.createElement('select');
        selectCola.style.cssText = estiloBtn + ';max-width:90px';
        selectCola.appendChild(new Option('Cola…', ''));
        for (const cola of CONFIG.sheet.colas || ['A', 'B', 'C']) {
            selectCola.appendChild(new Option(`Cola ${cola}`, cola));
        }
        selectCola.value = nombreCola();
        selectCola.onchange = () => {
            const v = selectCola.value.trim();
            if (v) localStorage.setItem(CLAVE_COLA, v);
            else localStorage.removeItem(CLAVE_COLA);
            pintar(v ? `Cola ${v}` : 'Cola: toda la hoja');
        };

        const selectIntervalo = document.createElement('select');
        selectIntervalo.style.cssText = estiloBtn + ';max-width:100px';
        for (const segs of CONFIG.intervalosSegundos || [5, 10, 15, 30, 45, 60]) {
            selectIntervalo.appendChild(new Option(`${segs} s`, String(segs)));
        }
        selectIntervalo.value = String(intervaloSegundos());
        selectIntervalo.onchange = () => {
            localStorage.setItem(CLAVE_INTERVALO, selectIntervalo.value);
            pintar(`Reintento cada ${selectIntervalo.value}s.`);
        };

        const selectSoftMax = document.createElement('select');
        selectSoftMax.style.cssText = estiloBtn + ';max-width:110px';
        for (const n of (CONFIG.reintento && CONFIG.reintento.softMaxOpciones) || [
            10, 20, 30, 50, 100,
        ]) {
            selectSoftMax.appendChild(new Option(`Soft ${n}`, String(n)));
        }
        selectSoftMax.value = String(softMaxSeguidos());
        selectSoftMax.onchange = () => {
            localStorage.setItem(CLAVE_SOFT_MAX, selectSoftMax.value);
            pintar(`Soft máx: ${selectSoftMax.value}`);
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
                pararAlarma();
                guardarEstado({ activo: false, reintentoSoft: false, proximo: 0 });
                pintar('Detenido.');
            } else {
                if (window.Notification && Notification.permission === 'default') {
                    await Notification.requestPermission();
                }
                softSeguidos = 0;
                localStorage.removeItem(claveSync());
                guardarEstado({ activo: true, ciclos: 0, proximo: 0, reintentoSoft: false });
                pintar('Iniciando POST…');
                ejecutarCiclo();
            }
            refrescarBoton();
        };

        refrescarBoton();
        botones.append(
            boton,
            botonSheet,
            botonBlob,
            selectCiudad,
            selectCola,
            selectIntervalo,
            selectSoftMax,
        );
        $panel.append(titulo, $estado, $blobEstado, botones, bloqueBlob);
        document.body.appendChild($panel);
        configValidadorLista();
        refrescarEstadoBlob();
    }

    // ─── Arranque ────────────────────────────────────────────────────────────

    instalarHookValidador();
    crearPanel();

    const estado = leerEstado();
    if (!estado.activo) {
        pintar('Inactivo. Pulsa Iniciar (solo POST).');
    } else if (!estado.proximo || Date.now() >= estado.proximo) {
        ejecutarCiclo();
    } else {
        programarSiguiente(Math.max(0, estado.proximo - Date.now()), {
            soft: !!estado.reintentoSoft,
        });
    }
})();

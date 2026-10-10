// ==UserScript==
// @name         Super Scheduler
// @namespace    super-scheduler
// @version      1.6
// @description  Appointment scheduling monitor
// @match        https://agendamiento.dian.gov.co/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @downloadURL  https://raw.githubusercontent.com/fernandoavila44/super-scheduler/master/scheduler.user.js
// @updateURL    https://raw.githubusercontent.com/fernandoavila44/super-scheduler/master/scheduler.user.js
// ==/UserScript==
//
// master = oficial. sandbox = pruebas.
//

(function () {
    'use strict';

    // ───────────────────────────── CONFIGURACIÓN ─────────────────────────────

    // Respaldo vacío a propósito: no subir cédulas al repo. La cola vive en la Sheet.
    // ciudadTramite: string o arreglo en orden de preferencia.
    const CLIENTES_INICIALES = [];

    const CONFIG = {
        // Página donde arranca el flujo. El script vuelve aquí en cada ciclo.
        // Player.aspx redirige a Default.aspx?Error=3; el recurso real es este.
        urlInicio: 'https://agendamiento.dian.gov.co',

        // URL /exec del API remoto: no va en el repo. Se guarda en localStorage
        // con el botón "Sheet URL" del panel (clave ssSheetUrl). Ver clientes-api.gs.
        sheet: {
            activo: true,
            url: '',
            timeoutMs: 15000,
        },

        intervaloMinutos: 1,

        // Tras agendar, si quedan clientes, espera esto y vuelve a empezar.
        segundosAntesDelSiguienteCliente: 8,

        // Margen alto: el sitio a veces tarda en pintar controles.
        timeoutElementoMs: 45000,

        // Pausa por defecto después de cada paso, si el paso no define "espera".
        pausaEntrePasosMs: 1200,

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
        // Cada paso acepta además: espera (ms) y opcional: true (si falta, no aborta).
        pasos: [
            { sel: 'div[nombrecontrol="btnSolicitarCita"]', desc: 'Solicitar cita', espera: 2000 },
            { sel: 'div.boton.btnTipoPersona[llave="1"]', desc: 'Tipo de persona', espera: 2000 },
            { sel: 'div.boton.btnTipoAtencion[llave="2"]', desc: 'Tipo de atención', espera: 2000 },
            {
                sel: 'div.boton.btnCategoria[llave="63071985-f5bd-43fe-beed-38f64c97371b"]',
                desc: 'Categoría del trámite',
                espera: 2000,
            },
            { accion: 'sinEspecialidades', desc: '¿Hay especialidades?' },
            // Abre el trámite y elige al primer cliente pendiente cuya ciudad
            // aparezca entre las opciones. Si no aparece, prueba con el siguiente.
            { accion: 'tramite', desc: 'Trámite del cliente', espera: 500 },
            // Hay un btnSiguiente por paso, más una variante btnSiguienteBlock que es
            // la deshabilitada. Se apunta al del PasoUno y solo al habilitado, así que
            // la espera del paso sirve también de garantía de que ya se puede avanzar.
            {
                sel: 'div[tipo="Control"][pantalla="PasoUno"][nombre="btnSiguiente"]',
                desc: 'Siguiente (paso uno)',
                espera: 2000,
            },
            // La fecha y la hora van juntas porque las horas dependen del día: si un
            // día no tiene horas libres hay que volver al calendario y probar otro.
            { accion: 'fechaYHora', desc: 'Fecha y hora', espera: 2000 },
            {
                sel: 'div[tipo="Control"][pantalla="PasoDos"][nombre="btnSiguiente"]',
                desc: 'Siguiente (paso dos)',
                espera: 2000,
            },
            // Aquí el monitor se detiene, avisa y espera a que resuelvas el captcha.
            { accion: 'captcha', desc: 'Captcha (manual)' },
            // El campo del documento solo se muestra con el captcha resuelto, y la
            // consulta se dispara al salir del campo.
            { accion: 'documento', desc: 'Número de documento', espera: 4000 },
            // Estos dos viven en contenedores que están ocultos hasta que la consulta
            // del documento responde, así que la espera del paso hace de sincronía.
            {
                sel: 'div[nombrecontrol="DatosCorretos"] input[type="radio"][value="1"]',
                marcar: true,
                desc: 'Datos correctos: Sí',
            },
            {
                sel: 'div[nombrecontrol="TerminosCondiciones"] input[type="checkbox"]',
                marcar: true,
                desc: 'Aceptar tratamiento de datos',
            },
            {
                sel: 'div[tipo="Control"][pantalla="PasoTres"][nombre="btnSiguiente"]',
                desc: 'Siguiente (paso tres)',
                espera: 3000,
            },
            // Paso irreversible: aquí la cita queda reservada. Comparte clase con
            // btnActualizarCita, así que se distingue por el atributo nombre.
            {
                sel: 'div[tipo="Control"][pantalla="PasoCuatro"][nombre="btnAgendarCita"]',
                desc: 'Agendar cita',
                espera: 3000,
            },
            // Confirmación. Hay un btnAceptar por modal, de ahí el filtro por pantalla.
            {
                sel: 'div[tipo="Control"][pantalla="ModalInfoCita"][nombre="btnAceptar"]',
                desc: 'Entendido',
                // El modal solo aparece cuando la cita ya quedó reservada.
                marcarCliente: true,
            },
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
            // Cuánto esperar las horas de un día antes de descartarlo y probar el
            // siguiente. Corto a propósito: se repite por cada día candidato.
            timeoutHorasMs: 8000,
        },

        captcha: {
            // reCAPTCHA escribe su token en este textarea de la propia página al
            // marcar la casilla: es la señal fiable de que ya está resuelto.
            selToken: '#g-recaptcha-response',
            // Margen para que llegues al navegador y lo marques.
            timeoutMs: 10 * 60 * 1000,
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

        sinEspecialidades: {
            // El aviso sale en la pantalla ModalError, que es genérica; el botón se
            // localiza por su pantalla para no confundirlo con el de otro modal.
            selAceptar: 'div[tipo="Control"][pantalla="ModalError"][nombre="btnAceptar"]',
            // Cuánto se espera a que el modal aparezca antes de dar por bueno el paso.
            timeoutMs: 4000,
            // Reintento más corto que el normal: los cupos del trámite aparecen y
            // desaparecen rápido, así que no vale la pena esperar el ciclo completo.
            minutosReintento: 1,
        },
    };

    // ─────────────────────────── ESTADO PERSISTENTE ───────────────────────────
    // Vive en localStorage porque el flujo recarga la página en cada ciclo.

    const CLAVE = 'ssMonitorState';
    const CLAVE_CLIENTES = 'ssMonitorClientes';
    const CLAVE_SHEET_URL = 'ssSheetUrl';
    const INTERVALO_MS = CONFIG.intervaloMinutos * 60 * 1000;

    // URL del Apps Script: CONFIG.sheet.url (vacío en git) o localStorage local.
    const urlSheet = () => (CONFIG.sheet.url || localStorage.getItem(CLAVE_SHEET_URL) || '').trim();

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

    const guardarClientes = (lista) => localStorage.setItem(CLAVE_CLIENTES, JSON.stringify(lista));

    function leerClientesGuardados() {
        try {
            const raw = JSON.parse(localStorage.getItem(CLAVE_CLIENTES));
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
    function fusionarClientes(base, { sheetManda = false } = {}) {
        const guardados = leerClientesGuardados();
        const porCedula = new Map(guardados.map((c) => [String(c.cedula), c]));

        const lista = base
            .map((c) => normalizarClienteRemoto(c))
            .filter((c) => c && c.cedula != null && c.ciudadTramite)
            .map((c) => {
                const previo = porCedula.get(String(c.cedula));
                if (sheetManda) return c;
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
        if (!url) return Promise.reject(new Error('no hay URL de Sheet configurada'));
        return gmRequest({ method: 'GET', url }).then((data) => {
            const arr = Array.isArray(data) ? data : data && data.clientes;
            if (!Array.isArray(arr)) throw new Error('la respuesta no trae un arreglo de clientes');
            return arr.map(normalizarClienteRemoto).filter(Boolean);
        });
    }

    // GET con action=schedule (más fiable que POST con los redirects de Apps Script).
    function actualizarClienteSheet({ cedula, date, hour, scheduled = true }) {
        const base = urlSheet();
        if (!base) return Promise.reject(new Error('no hay URL de Sheet configurada'));
        const sep = base.includes('?') ? '&' : '?';
        const qs = new URLSearchParams({
            action: 'schedule',
            cedula: String(cedula),
            scheduled: scheduled ? 'true' : 'false',
            date: date || '',
            hour: hour || '',
        });
        return gmRequest({ method: 'GET', url: base + sep + qs.toString() }).then((data) => {
            if (!data || data.ok === false) throw new Error((data && data.error) || 'la Sheet rechazó la actualización');
            return data;
        });
    }

    // Al inicio de cada ciclo. Si la Sheet falla, se usa la última caché local
    // (nunca CLIENTES_INICIALES vacío: eso hacía creer que "todos están agendados").
    // confiable=true solo cuando la Sheet respondió bien: solo entonces FinCola.
    async function sincronizarClientes() {
        const cache = leerClientesGuardados();
        const { activo } = CONFIG.sheet;
        const url = urlSheet();

        if (!activo || !url) {
            if (cache.length) {
                log(`Sheet sin URL; se usa caché local (${cache.length} clientes)`);
                return { clientes: cache, confiable: false };
            }
            const lista = fusionarClientes(CLIENTES_INICIALES);
            return { clientes: lista, confiable: false };
        }

        try {
            const remotos = await pedirClientesSheet();
            if (!remotos.length) {
                if (cache.length) {
                    log('Sheet vacía o sin filas; se conserva la caché local');
                    return { clientes: cache, confiable: false };
                }
                return { clientes: [], confiable: true };
            }
            const pendientes = remotos.filter((c) => !c.scheduled).length;
            log(`Sheet: ${remotos.length} cliente(s), ${pendientes} pendiente(s)`);
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
        return (el && (el.innerText || '').trim()) || '';
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

    async function marcarAgendado() {
        if (!clienteActual) return;
        const lista = cargarClientes();
        const cliente = lista.find((c) => String(c.cedula) === String(clienteActual.cedula));
        if (!cliente) return;

        const cita = leerResumenCita();
        cliente.scheduled = true;
        cliente.cita = cita;
        guardarClientes(lista);
        log(
            `   ${cliente.cedula} agendado: ${cita.fecha || '?'} ${cita.hora || '?'} — ${
                cita.tramite || cliente.ciudadTramite
            }`,
        );

        try {
            await actualizarClienteSheet({
                cedula: cliente.cedula,
                scheduled: true,
                date: cita.fecha,
                hour: cita.hora,
            });
            log('   Sheet actualizada (scheduled/date/hour)');
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
    // reintentoMs permite acortar la espera cuando conviene insistir antes.
    class SinCupo extends Error {
        constructor(mensaje, reintentoMs) {
            super(mensaje);
            this.reintentoMs = reintentoMs;
        }
    }

    // La cola se acabó: no tiene sentido seguir recargando.
    class FinCola extends Error {}

    const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

    const visible = (el) => !!(el && el.offsetParent !== null);

    // Sin tildes, sin mayúsculas y con los espacios colapsados, para que
    // "Bogotá - Univ. La Gran Colombia" case con "Bogota".
    const normalizar = (s) =>
        s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

    // Las opciones del trámite vienen entre comillas y a veces con un punto final.
    // Se las quita para compararlas con ciudadTramite.
    const limpiarTramite = (s) => normalizar(String(s)).replace(/["“”«»'`´.]/g, '').replace(/\s+/g, ' ').trim();

    function buscar(sel, contiene) {
        const nodos = Array.from(document.querySelectorAll(sel)).filter(visible);
        if (!contiene) return nodos[0] || null;
        const objetivo = contiene.trim().toLowerCase();
        return nodos.find((n) => (n.innerText || n.value || '').trim().toLowerCase().includes(objetivo)) || null;
    }

    async function esperarElemento(sel, contiene, timeout) {
        const limite = Date.now() + timeout;
        while (Date.now() < limite) {
            const el = buscar(sel, contiene);
            if (el) return el;
            await dormir(250);
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

        select.value = opcion.value;
        disparar(select, ['input', 'change']);
        select.blur();
        return opcion;
    }

    // Las horas que ofrece la página dependen del día elegido, así que un día
    // habilitado en el calendario no garantiza horas libres. Se recorren los días
    // habilitados y se toma el primero que sí tenga horas.
    async function elegirFechaYHora() {
        const { selBoton, selAbierto, selDia, selHoras, timeoutHorasMs } = CONFIG.fechaYHora;

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
            clicar(resolverObjetivo(boton));
            if (!(await esperarElemento(selAbierto, null, 5000))) throw new Error('El calendario no se desplegó');
        }

        await abrirCalendario();

        // Se guardan los data-value y no los nodos porque el calendario se vuelve
        // a dibujar cada vez que se abre y las referencias quedarían obsoletas.
        const dias = Array.from(document.querySelectorAll(selDia))
            .filter(visible)
            .map((a) => a.getAttribute('data-value'))
            .filter(Boolean);

        if (!dias.length) throw new SinCupo('el calendario no tiene días habilitados');
        log(`   días habilitados: ${dias.length}`);

        for (const valor of dias) {
            await abrirCalendario();

            const dia = buscar(`${selDia}[data-value="${valor}"]`);
            if (!dia) {
                log(`   el día ${valor} ya no está habilitado`);
                continue;
            }

            log(`   probando ${dia.title || valor}`);
            clicar(dia);
            await dormir(CONFIG.pausaEntrePasosMs);

            const horas = await esperarElemento(selHoras, null, 5000);
            const opcion = horas && (await elegirOpcion(horas, (o) => o.value !== '', timeoutHorasMs));
            if (opcion) {
                log(`   hora elegida: ${opcion.textContent.trim()}`);
                return true;
            }

            log('   ese día no tiene horas libres');
        }

        throw new SinCupo('ningún día habilitado tiene horas libres');
    }

    // El reCAPTCHA vive en un iframe de google.com: el script no puede marcarlo
    // (es otro origen) y Google rechaza los clics sintéticos incluso si pudiera.
    // Lo resuelve la persona. Llegar hasta aquí ya significa que hay fecha y hora
    // libres, así que es el momento exacto de avisar y dejar de recargar.
    async function esperarCaptcha() {
        const { selToken, timeoutMs } = CONFIG.captcha;

        detener('¡CUPOS! Marca el captcha y el script sigue solo.');

        const limite = Date.now() + timeoutMs;
        while (Date.now() < limite) {
            const token = document.querySelector(selToken);
            if (token && token.value) {
                pararAlarma();
                log('captcha resuelto, continuando');
                return true;
            }
            await dormir(500);
        }
        pararAlarma();
        throw new Error('el captcha no se resolvió a tiempo');
    }

    // La lista de trámites cambia en cada ciclo. Se recorre la cola y se queda con
    // el primer pendiente cuya ciudadTramite esté entre las opciones.
    async function elegirTramite() {
        const sel = 'div[nombrecontrol="Servicios"] select.customSelect';
        const select = await esperarElemento(sel, null, CONFIG.timeoutElementoMs);
        if (!select) {
            throw new SinCupo('No apareció el trámite', CONFIG.sinEspecialidades.minutosReintento * 60 * 1000);
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
            throw new SinCupo('el trámite no cargó opciones', CONFIG.sinEspecialidades.minutosReintento * 60 * 1000);
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
            log(`   cliente ${cliente.cedula}: ${hallado.opcion.textContent.trim()}`);
            return true;
        }

        throw new SinCupo(
            'ningún cliente pendiente coincide con los trámites disponibles',
            CONFIG.sinEspecialidades.minutosReintento * 60 * 1000,
        );
    }

    async function escribirDocumento() {
        if (!clienteActual) throw new Error('No hay un cliente seleccionado para el documento');

        const campo = await esperarElemento(
            '#divPasoTresNumeroDocumento input',
            null,
            CONFIG.timeoutElementoMs,
        );
        if (!campo) throw new Error('No apareció el número de documento');

        campo.scrollIntoView({ block: 'center' });
        campo.focus();
        campo.value = String(clienteActual.cedula);
        disparar(campo, ['input', 'change', 'keyup']);
        // La consulta del documento se dispara al salir del campo.
        campo.blur();
        clicar(document.body);
        log(`   documento ${clienteActual.cedula}`);
    }

    // Al elegir el trámite la página puede responder con el modal de que no hay
    // especialidades. Es un "no hay cupo" temprano: se cierra el aviso y se
    // reintenta pronto, sin recorrer el resto del flujo.
    async function revisarSinEspecialidades() {
        const { selAceptar, timeoutMs, minutosReintento } = CONFIG.sinEspecialidades;
        const limite = Date.now() + timeoutMs;

        while (Date.now() < limite) {
            // Si el trámite ya tiene opciones, no hay modal que esperar: seguir
            // aquí gastaba el timeout completo (4 s) en cada ciclo con cupo.
            const select = document.querySelector('div[nombrecontrol="Servicios"] select.customSelect');
            if (select && Array.from(select.options).some((o) => o.value !== '')) return true;

            // innerText solo incluye lo que se está mostrando, así que detecta el
            // aviso sin depender de cómo esté posicionado el modal.
            if (avisoSinCupo()) {
                const aceptar = document.querySelector(selAceptar);
                if (aceptar) {
                    log('   cerrando el aviso');
                    clicar(resolverObjetivo(aceptar));
                    await dormir(CONFIG.pausaEntrePasosMs);
                }
                throw new SinCupo('no hay especialidades para el trámite', minutosReintento * 60 * 1000);
            }
            await dormir(300);
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
            await dormir(paso.espera ?? CONFIG.pausaEntrePasosMs);
            return true;
        }

        if (paso.accion === 'documento') {
            await escribirDocumento();
            await dormir(paso.espera ?? CONFIG.pausaEntrePasosMs);
            return true;
        }

        if (paso.accion === 'fechaYHora') {
            await elegirFechaYHora();
            await dormir(paso.espera ?? CONFIG.pausaEntrePasosMs);
            return true;
        }

        if (paso.accion === 'captcha') {
            await esperarCaptcha();
            await dormir(paso.espera ?? CONFIG.pausaEntrePasosMs);
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
            if (paso.marcarCliente) await marcarAgendado();
            clicar(resolverObjetivo(el));
        }

        await dormir(paso.espera ?? CONFIG.pausaEntrePasosMs);
        return true;
    }

    // ───────────────────────────── DETECCIÓN Y ALARMA ─────────────────────────

    // La disponibilidad ya no se deduce de un aviso: se comprueba llegando a una
    // fecha con horas libres. Este aviso solo sirve para distinguir "no hay nada"
    // de "el script se rompió" cuando el flujo se queda en el PasoUno.
    const avisoSinCupo = () => {
        const aviso = normalizar(CONFIG.textoSinCupo);
        return !!aviso && normalizar(document.body.innerText).includes(aviso);
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

        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Tras una recarga no hay gesto del usuario, así que Chrome puede
            // dejar el contexto suspendido y el pitido no suena.
            ctx.resume().catch(() => {});
            if (ctx.state === 'suspended') {
                log(
                    'audio bloqueado por la política de autoplay del navegador; ' +
                        'quedan la notificación y el título',
                );
            }

            const rafaga = () => {
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

        const original = document.title;
        let on = false;
        temporizadores.push(
            setInterval(() => {
                document.title = (on = !on) ? '*** CUPOS ***' : original;
            }, 800),
        );

        pararAlarma = () => {
            temporizadores.forEach(clearInterval);
            document.title = original;
            if (ctx) ctx.close().catch(() => {});
            pararAlarma = () => {};
        };
    }

    // ───────────────────────────────── CICLO ──────────────────────────────────

    async function ejecutarCiclo() {
        const estado = guardarEstado({ ejecutando: true, ciclos: (leerEstado().ciclos || 0) + 1 });
        pintar(`Ciclo ${estado.ciclos} en curso...`);

        let resultado;
        let exito = false;
        let esperaMs = INTERVALO_MS;
        try {
            const { clientes, confiable } = await sincronizarClientes();
            const pendientes = clientes.filter((c) => !c.scheduled);
            pintar(`Ciclo ${estado.ciclos}: ${pendientes.length} pendiente(s)...`);
            if (!pendientes.length) {
                // Solo si la Sheet respondió: si falló la red y la caché quedó vacía
                // o solo con agendados dudosos, no apagar el monitor como "fin de cola".
                if (confiable) throw new FinCola('Todos los clientes ya están agendados');
                throw new Error('sin pendientes en caché (la Sheet no confirmó el estado)');
            }

            for (const paso of CONFIG.pasos) {
                log(`→ ${paso.desc || paso.sel}`);
                await ejecutarPaso(paso);
            }
            resultado = 'cita agendada, revisa el navegador y el correo';
            exito = true;

            // detener() apagó el monitor al llegar al captcha para no recargar el
            // formulario. Con la cita ya hecha, si queda gente en la cola se enciende
            // otra vez y el siguiente ciclo arranca desde el inicio.
            const quedan = cargarClientes().some((c) => !c.scheduled);
            if (quedan) {
                const segundos = CONFIG.segundosAntesDelSiguienteCliente;
                guardarEstado({ activo: true, ejecutando: false, ultimo: resultado });
                refrescarBoton();
                pintar(`Ciclo ${estado.ciclos}: ${resultado}. Siguiente cliente en ${segundos} s.`, true);
                programarSiguiente(segundos * 1000);
                return;
            }
            resultado = 'cita agendada. No quedan clientes pendientes';
        } catch (e) {
            if (e instanceof FinCola) {
                guardarEstado({ activo: false, ejecutando: false, ultimo: e.message });
                pintar(e.message, true);
                refrescarBoton();
                return;
            }
            resultado = e instanceof SinCupo ? `sin cupo (${e.message})` : `falló: ${e.message}`;
            if (e instanceof SinCupo && e.reintentoMs) esperaMs = e.reintentoMs;
        }

        // El paso del captcha detiene el monitor en cuanto confirma que hay cita,
        // así que desde ahí no se recarga más: hacerlo borraría el formulario.
        if (!leerEstado().activo) {
            pintar(`Ciclo ${estado.ciclos}: ${resultado}`, exito);
            return;
        }

        const minutos = Math.round((esperaMs / 60000) * 10) / 10;
        pintar(`Ciclo ${estado.ciclos}: ${resultado}. Reintento en ${minutos} min.`);
        programarSiguiente(esperaMs);
    }

    function programarSiguiente(esperaMs = INTERVALO_MS) {
        guardarEstado({ ejecutando: false, proximo: Date.now() + esperaMs });
        setTimeout(() => {
            if (leerEstado().activo) location.href = CONFIG.urlInicio;
        }, esperaMs);
    }

    // ─────────────────────────────── PANEL / LOG ──────────────────────────────

    let $panel, $estado;
    let refrescarBoton = () => {};

    function log(msg) {
        console.log('[scheduler]', msg);
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

        refrescarBoton = () => {
            boton.textContent = leerEstado().activo ? 'Detener' : 'Iniciar';
        };

        boton.onclick = async () => {
            if (leerEstado().activo) {
                guardarEstado({ activo: false });
                pintar('Detenido.');
            } else {
                if (window.Notification && Notification.permission === 'default') await Notification.requestPermission();
                guardarEstado({ activo: true, ciclos: 0, proximo: 0 });
                pintar('Iniciando...');
                ejecutarCiclo();
            }
            refrescarBoton();
        };

        refrescarBoton();
        botones.append(boton, botonExportar, botonSheet);
        $panel.append(titulo, $estado, botones);
        document.body.appendChild($panel);
    }

    // ────────────────────────────────── ARRANQUE ──────────────────────────────

    crearPanel();

    const estado = leerEstado();
    if (!estado.activo) {
        pintar('Inactivo. Pulsa Iniciar.');
    } else if (!estado.proximo || Date.now() >= estado.proximo) {
        ejecutarCiclo();
    } else {
        const resta = estado.proximo - Date.now();
        pintar(`En espera: próximo intento en ${Math.ceil(resta / 1000)} s.`);
        setTimeout(() => {
            if (leerEstado().activo) location.href = CONFIG.urlInicio;
        }, resta);
    }
})();

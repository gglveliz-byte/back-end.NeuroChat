const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://neurochat_ai_user:sc7eCAhWMQ8oudJk17B7X3HC6Ra0X9vV@dpg-d6gg3q0gjchc73c4i5rg-a.virginia-postgres.render.com/neurochat_ai',
  ssl: { rejectUnauthorized: false }
});

const FACTURACION_TEMPLATE = `=== PLANTILLA DE ENTREGABLE - FACTURACION ===

Tu entregable debe ser un objeto JSON con EXACTAMENTE estos campos.
Lee la descripcion de cada campo para saber que valor poner.

CAMPOS DEL ENTREGABLE:

1. "Evaluador"
   Descripcion: Nombre del evaluador. Como eres una IA, pon siempre "IA - Agente de Calidad".

2. "Cuenta"
   Descripcion: Numero de cuenta del cliente. Pon "-" (el sistema lo completa automaticamente).

3. "Momento de verdad o dolor"
   Descripcion: Categoria del flujo evaluado. Para esta plantilla siempre pon "Facturacion".

4. "Motivo Monitoreo"
   Descripcion: Motivo por el cual se realiza la llamada. Identifica en la transcripcion si es "Consulta", "Reclamo", "Solicitud", etc. Si no lo puedes determinar, pon "Consulta".

5. "Saludo y presentacion" [No Critico]
   Descripcion: Evalua si el asesor saludo correctamente al inicio de la llamada, se presento con su nombre y la empresa. Pon "SI" si lo hizo, "NO" si no lo hizo. Usa las reglas de la plantilla de calificacion para este criterio.

6. "Tono y voz" [No Critico]
   Descripcion: Evalua si el asesor mantuvo un tono de voz adecuado, amable y profesional durante la llamada. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

7. "Validacion de Identidad" [Critico]
   Descripcion: Evalua si el asesor valido la identidad del titular (pidio cedula, nombre completo, datos de la cuenta). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

8. "Validacion de Historial" [Critico]
   Descripcion: Evalua si el asesor reviso el historial del cliente (consultas previas, pagos anteriores, estado de cuenta). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

9. "Registro en CRM" [Critico]
   Descripcion: Evalua si el asesor registro o menciono el registro de la interaccion en el sistema/CRM. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

10. "Cierre con compromiso" [No Critico]
    Descripcion: Evalua si el asesor realizo un cierre efectivo de la llamada: resumen de lo tratado, proximos pasos, despedida, transferencia a encuesta. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

11. "Direccion de la conversacion" [Critico]
    Descripcion: Evalua si el asesor mantuvo el control y direccion de la conversacion, guiando al cliente hacia la solucion sin desviarse. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

12. "Escucha activa y entendimiento" [Critico]
    Descripcion: Evalua si el asesor demostro escucha activa (no interrumpio, confirmo lo que el cliente decia, reformulo para validar entendimiento). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

13. "Empatia y contencion emocional" [No Critico]
    Descripcion: Evalua si el asesor mostro empatia ante la situacion del cliente (frases de comprension, disculpas cuando corresponde, contencion emocional si el cliente estaba frustrado). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

14. "Identificacion correcta del motivo de facturacion" [Critico]
    Descripcion: Evalua si el asesor identifico correctamente el motivo de la consulta de facturacion del cliente (por que llama, que necesita saber sobre su factura). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

15. "Validacion de Entrega de documentos (FACTURA POR CORREO)" [Critico]
    Descripcion: Evalua si el asesor valido que el cliente recibe su factura por correo electronico (confirmo correo, pregunto si le llega la factura). Pon "SI" si lo valido, "NO" si omitio hacerlo. Usa las reglas de la plantilla de calificacion para este criterio.

16. "Validacion de fechas de recepcion de factura los primeros de cada mes" [Critico]
    Descripcion: Evalua si el asesor le recordo al cliente que los pagos deben realizarse los 10 primeros dias del mes o menciono las fechas de facturacion. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

17. "Validacion de valores facturados vs contratados" [Critico]
    Descripcion: Evalua si el asesor valido o informo los valores de la factura vs el plan contratado (valor del plan, desglose, diferencias). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

18. "Validacion y uso correcto de promociones y politicas vigentes" [Critico]
    Descripcion: Evalua si el asesor informo correctamente sobre promociones, politicas vigentes, o descuentos aplicables al plan del cliente. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

19. "Usuario Asesor"
    Descripcion: Codigo o nombre del asesor que atendio la llamada. Buscalo en la transcripcion (generalmente se identifica al inicio). Si no se puede identificar, pon "-".

20. "Comentarios Generales"
    Descripcion: Escribe un parrafo narrativo y detallado describiendo la llamada como lo haria un evaluador humano. Incluye: quien se comunica, por que motivo llama, que hace el asesor, que informacion proporciona, que resuelve, y que omite. Si hay numero de grabacion mencionalo al inicio entre parentesis.
    Ejemplo de estilo: "Titular consulta que antes pagaba $18 ahora cancela $25,44. Asesor informa plan actual y 500 megas que posee, informa que diferencia de $3.45 pertenece al pago por reconexion, realiza detalle de factura desde enero de $21,99 valor del plan, el pago de la factura lo realizo el dia 12 y le recuerda que debe ser los 10 primeros dias del mes. Se despide y transfiere a encuesta. Solo omite validar la recepcion de la factura al correo."

21. "Puntaje"
    Descripcion: Calcula el porcentaje como decimal entre 0 y 1. Usa los pesos de la plantilla de calificacion para calcular: suma los pesos de los criterios que tienen "SI" y divide entre la suma total de todos los pesos. Redondea a 2 decimales. Ejemplo: si de 14 criterios 13 son SI y el que fallo es Critico, el puntaje sera cercano a 0.92.`;

const PAGOS_TEMPLATE = `=== PLANTILLA DE ENTREGABLE - PAGOS ===

Tu entregable debe ser un objeto JSON con EXACTAMENTE estos campos.
Lee la descripcion de cada campo para saber que valor poner.

CAMPOS DEL ENTREGABLE:

1. "Evaluador"
   Descripcion: Nombre del evaluador. Como eres una IA, pon siempre "IA - Agente de Calidad".

2. "Cuenta"
   Descripcion: Numero de cuenta del cliente. Pon "-" (el sistema lo completa automaticamente).

3. "Momento de verdad o dolor"
   Descripcion: Categoria del flujo evaluado. Para esta plantilla siempre pon "Pagos".

4. "Motivo Monitoreo"
   Descripcion: Motivo por el cual se realiza la llamada. Identifica en la transcripcion si es "Consulta", "Reclamo", "Solicitud", etc. Si no lo puedes determinar, pon "Consulta".

5. "Saludo y presentacion" [No Critico]
   Descripcion: Evalua si el asesor saludo correctamente al inicio de la llamada, se presento con su nombre y la empresa. Pon "SI" si lo hizo, "NO" si no lo hizo. Usa las reglas de la plantilla de calificacion para este criterio.

6. "Tono y voz" [No Critico]
   Descripcion: Evalua si el asesor mantuvo un tono de voz adecuado, amable y profesional durante la llamada. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

7. "Validacion de Identidad" [Critico]
   Descripcion: Evalua si el asesor valido la identidad del titular (pidio cedula, nombre completo, datos de la cuenta). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

8. "Validacion de Historial" [Critico]
   Descripcion: Evalua si el asesor reviso el historial del cliente (consultas previas, pagos anteriores, estado de cuenta). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

9. "Registro en CRM" [Critico]
   Descripcion: Evalua si el asesor registro o menciono el registro de la interaccion en el sistema/CRM. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

10. "Cierre con compromiso" [No Critico]
    Descripcion: Evalua si el asesor realizo un cierre efectivo de la llamada: resumen de lo tratado, proximos pasos, despedida, transferencia a encuesta. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

11. "Direccion de la conversacion" [Critico]
    Descripcion: Evalua si el asesor mantuvo el control y direccion de la conversacion, guiando al cliente hacia la solucion sin desviarse. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

12. "Escucha activa y entendimiento" [Critico]
    Descripcion: Evalua si el asesor demostro escucha activa (no interrumpio, confirmo lo que el cliente decia, reformulo para validar entendimiento). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

13. "Empatia y contencion emocional" [No Critico]
    Descripcion: Evalua si el asesor mostro empatia ante la situacion del cliente (frases de comprension, disculpas cuando corresponde, contencion emocional si el cliente estaba frustrado). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

14. "Identificacion correcta del motivo de facturacion" [Critico]
    Descripcion: Evalua si el asesor identifico correctamente que el cliente llama por un tema de PAGO (solicitar link de pago, consultar como pagar, problemas con pago). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

15. "Validacion de Entrega de documentos (FACTURA POR CORREO)" [No aplica en Pagos]
    Descripcion: Este criterio NO APLICA para el flujo de Pagos. Deja este campo VACIO (""). No lo evalues ni lo cuentes para el puntaje.

16. "Validacion de fechas de recepcion de factura los primeros de cada mes" [Critico]
    Descripcion: Evalua si el asesor le recordo al cliente que los pagos deben realizarse los 10 primeros dias del mes. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

17. "Validacion de valores facturados vs contratados" [Critico]
    Descripcion: Evalua si el asesor informo o confirmo el valor del plan contratado y/o el monto a pagar. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

18. "Medio para enviar link de pago (por w.s o correo)" [Critico]
    Descripcion: Evalua si el asesor pregunto al cliente por que medio desea recibir el link de pago (WhatsApp o correo electronico). Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

19. "Validacion de medio para envio de link de pago (numero de telefono o correo)" [Critico]
    Descripcion: Evalua si el asesor valido el numero de telefono o correo electronico donde enviara el link de pago. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

20. "Envio correcto del link de pago/confirmacion" [Critico]
    Descripcion: Evalua si el asesor envio el link de pago y confirmo con el cliente que lo recibio correctamente. Pon "SI" o "NO". Usa las reglas de la plantilla de calificacion para este criterio.

21. "Usuario Asesor"
    Descripcion: Codigo o nombre del asesor que atendio la llamada. Buscalo en la transcripcion (generalmente se identifica al inicio). Si no se puede identificar, pon "-".

22. "Comentarios Generales"
    Descripcion: Escribe un parrafo narrativo y detallado describiendo la llamada como lo haria un evaluador humano. Incluye: quien se comunica, por que motivo llama, que hace el asesor, que informacion proporciona, que resuelve, y que omite. Si hay numero de grabacion mencionalo al inicio entre parentesis.
    Ejemplo de estilo: "Se comunica titular a solicitar el link de pago, asesor realiza validacion de datos y medio para enviar el link/WhatsApp, luego confirma la recepcion y clte indica que ya le llego, pero omite validar los pagos los 10 primeros dias del mes y el valor del plan, se despide y transfiere a encuesta."

23. "Puntaje"
    Descripcion: Calcula el porcentaje como decimal entre 0 y 1. Usa los pesos de la plantilla de calificacion para calcular: suma los pesos de los criterios evaluables que tienen "SI" y divide entre la suma total de pesos evaluables (NO incluyas el criterio 15 "Entrega de documentos" que no aplica en Pagos). Redondea a 2 decimales.`;

(async () => {
  const client = await pool.connect();
  try {
    const r1 = await client.query(
      "UPDATE chatbot_saas.b2b_agents SET deliverable_template = $1 WHERE id = 'acaccaa7-02b7-4c0d-abdc-dbba76f80693'",
      [FACTURACION_TEMPLATE]
    );
    console.log('Facturacion updated:', r1.rowCount, 'row(s)');

    const r2 = await client.query(
      "UPDATE chatbot_saas.b2b_agents SET deliverable_template = $1 WHERE id = 'd9ff1505-b4d7-41ad-9282-9983d244a3ca'",
      [PAGOS_TEMPLATE]
    );
    console.log('Pagos updated:', r2.rowCount, 'row(s)');
  } catch(e) { console.error('ERROR:', e.message); }
  finally { client.release(); await pool.end(); }
})();

const ExcelJS = require('exceljs');
const { query } = require('../config/database');

// ─── B2B Export Service v3 (ExcelJS — styled) ──────────────────
// Generates beautiful, branded Excel reports from interactions.
// Returns a Buffer for streaming download.

// ─── Brand Colors ───────────────────────────────────────────────
const COLORS = {
  brand:      '7C3AED', // purple-600
  brandDark:  '5B21B6', // purple-800
  brandLight: 'EDE9FE', // purple-50
  headerBg:   '0F172A', // slate-900
  headerFg:   'F8FAFC', // slate-50
  subHeaderBg:'1E293B', // slate-800
  subHeaderFg:'CBD5E1', // slate-300
  success:    '10B981', // emerald-500
  successBg:  'ECFDF5', // emerald-50
  warning:    'F59E0B', // amber-500
  warningBg:  'FFFBEB', // amber-50
  danger:     'EF4444', // red-500
  dangerBg:   'FEF2F2', // red-50
  infoBg:     'F0F9FF', // sky-50
  rowAlt:     'F8FAFC', // slate-50
  rowWhite:   'FFFFFF',
  border:     'E2E8F0', // slate-200
  textDark:   '0F172A',
  textMuted:  '64748B', // slate-500
};

const FONT_MAIN = 'Calibri';

/**
 * Generate styled Excel buffer for interactions in a date range
 */
async function generateExcel(areaId, dateFrom, dateTo) {
  const areaResult = await query(
    'SELECT display_name, name FROM b2b_areas WHERE id = $1',
    [areaId]
  );
  if (!areaResult.rows[0]) throw new Error(`Area not found: ${areaId}`);
  const areaName = areaResult.rows[0].display_name;

  const result = await query(
    `SELECT
       i.id,
       i.channel,
       i.source_id,
       i.status,
       i.assigned_agent,
       i.agent_result,
       i.filter_result,
       i.raw_text,
       i.human_reviewer,
       i.reprocess_count,
       i.voice_metrics,
       i.processed_at,
       i.reviewed_at,
       i.created_at
     FROM b2b_interactions i
     WHERE i.b2b_area_id = $1
       AND i.status IN ('aprobado', 'en_revision', 'rechazado', 'analizando')
       AND i.created_at >= ($2::date AT TIME ZONE 'America/Guayaquil')
       AND i.created_at < (($3::date + interval '1 day') AT TIME ZONE 'America/Guayaquil')
     ORDER BY i.created_at DESC`,
    [areaId, dateFrom, dateTo]
  );

  const rows = result.rows;
  const hasV2 = rows.some(r => r.agent_result && Array.isArray(r.agent_result.criterios));

  // Check if agent has a deliverable template (client-defined export format)
  const agentTemplateResult = await query(
    `SELECT ag.deliverable_template
     FROM b2b_agents ag
     WHERE ag.b2b_area_id = $1 AND ag.type = 'specialized' AND ag.is_active = true
       AND ag.deliverable_template IS NOT NULL AND ag.deliverable_template != ''
     LIMIT 1`,
    [areaId]
  );
  const deliverableTemplate = agentTemplateResult.rows[0]?.deliverable_template;
  const hasEntregable = rows.some(r => r.agent_result?.entregable && Object.keys(r.agent_result.entregable).length > 0);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'NeuroChat B2B';
  wb.created = new Date();

  if (hasEntregable && deliverableTemplate) {
    // Use client's deliverable template format
    await buildTemplateWorkbook(wb, rows, areaName, dateFrom, dateTo, deliverableTemplate);
  } else if (hasEntregable) {
    // Auto-build from entregable keys (evaluation template-based)
    await buildAutoEntregableWorkbook(wb, rows, areaName, dateFrom, dateTo);
  } else if (hasV2) {
    await buildV2Workbook(wb, rows, areaName, dateFrom, dateTo);
  } else {
    await buildLegacyWorkbook(wb, rows, areaName, dateFrom, dateTo);
  }

  const buffer = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(buffer), totalRecords: rows.length, areaName };
}

// ─── Helpers ────────────────────────────────────────────────────

function fmtDate(date) {
  if (!date) return '-';
  return new Date(date).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDateShort(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusLabel(status) {
  const map = { aprobado: 'Aprobado', en_revision: 'En Revision', rechazado: 'Rechazado', analizando: 'Analizando' };
  return map[status] || status || '-';
}

function statusColor(status) {
  if (status === 'aprobado') return { bg: COLORS.successBg, fg: COLORS.success };
  if (status === 'rechazado') return { bg: COLORS.dangerBg, fg: COLORS.danger };
  if (status === 'en_revision') return { bg: COLORS.warningBg, fg: COLORS.warning };
  return { bg: COLORS.infoBg, fg: COLORS.textMuted };
}

function scoreColor(pct) {
  if (pct >= 80) return { bg: COLORS.successBg, fg: COLORS.success };
  if (pct >= 50) return { bg: COLORS.warningBg, fg: COLORS.warning };
  return { bg: COLORS.dangerBg, fg: COLORS.danger };
}

function applyHeaderStyle(cell) {
  cell.font = { name: FONT_MAIN, bold: true, size: 10, color: { argb: COLORS.headerFg } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border = {
    bottom: { style: 'medium', color: { argb: COLORS.brand } }
  };
}

function applySubHeaderStyle(cell) {
  cell.font = { name: FONT_MAIN, bold: true, size: 9, color: { argb: COLORS.subHeaderFg } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subHeaderBg } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

function applyCellStyle(cell, rowIdx) {
  const bgColor = rowIdx % 2 === 0 ? COLORS.rowWhite : COLORS.rowAlt;
  cell.font = { name: FONT_MAIN, size: 9, color: { argb: COLORS.textDark } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
  cell.alignment = { vertical: 'middle', wrapText: true };
  cell.border = {
    bottom: { style: 'thin', color: { argb: COLORS.border } }
  };
}

function buildTitleSection(ws, areaName, dateFrom, dateTo, rows) {
  // Row 1: Brand title
  ws.mergeCells('A1:H1');
  const titleCell = ws.getCell('A1');
  titleCell.value = 'NEUROCHAT B2B — REPORTE DE CALIDAD';
  titleCell.font = { name: FONT_MAIN, bold: true, size: 16, color: { argb: COLORS.headerFg } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.brand } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 40;

  // Row 2: Area + dates
  ws.mergeCells('A2:H2');
  const subCell = ws.getCell('A2');
  subCell.value = `Area: ${areaName}  |  Periodo: ${fmtDateShort(dateFrom)} — ${fmtDateShort(dateTo)}`;
  subCell.font = { name: FONT_MAIN, size: 11, color: { argb: COLORS.subHeaderFg } };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(2).height = 28;

  // Row 3: Stats summary
  const approved = rows.filter(r => r.status === 'aprobado').length;
  const review = rows.filter(r => r.status === 'en_revision').length;
  const rejected = rows.filter(r => r.status === 'rechazado').length;

  // Calculate average score
  let avgScore = 0;
  let scoreCount = 0;
  for (const r of rows) {
    const ar = r.agent_result || {};
    if (ar.porcentaje != null) { avgScore += Number(ar.porcentaje); scoreCount++; }
    else if (ar.calificacion != null) { avgScore += Number(ar.calificacion) * 10; scoreCount++; }
  }
  avgScore = scoreCount > 0 ? (avgScore / scoreCount).toFixed(1) : '-';

  ws.mergeCells('A3:H3');
  const statsCell = ws.getCell('A3');
  statsCell.value = `Total: ${rows.length} registros  |  Aprobados: ${approved}  |  En revision: ${review}  |  Rechazados: ${rejected}  |  Puntaje promedio: ${avgScore}%`;
  statsCell.font = { name: FONT_MAIN, size: 10, color: { argb: COLORS.brand } };
  statsCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.brandLight } };
  statsCell.alignment = { vertical: 'middle', horizontal: 'center' };
  statsCell.border = {
    bottom: { style: 'medium', color: { argb: COLORS.brand } }
  };
  ws.getRow(3).height = 26;

  // Row 4: Empty separator
  ws.getRow(4).height = 8;

  return 5; // data starts at row 5
}

// ─── V2 (criteria-based) workbook ───────────────────────────────

async function buildV2Workbook(wb, rows, areaName, dateFrom, dateTo) {
  // ── Sheet 1: Resumen ──
  const wsSummary = wb.addWorksheet('Resumen', {
    properties: { tabColor: { argb: COLORS.brand } }
  });

  const startRow = buildTitleSection(wsSummary, areaName, dateFrom, dateTo, rows);

  // Collect all unique criteria
  const allCriteriaIds = new Map();
  for (const row of rows) {
    if (row.agent_result?.criterios) {
      for (const c of row.agent_result.criterios) {
        if (c.id && !allCriteriaIds.has(c.id)) {
          allCriteriaIds.set(c.id, { nombre: c.nombre || c.id, critico: c.critico || false });
        }
      }
    }
  }
  const criteriaList = Array.from(allCriteriaIds.entries());

  // Headers
  const fixedHeaders = [
    'N', 'ID Grabacion', 'Canal', 'Estado', 'Agente', 'Puntaje', '%', 'Criticos Fallidos'
  ];
  const criteriaHeaders = criteriaList.map(([id, info]) => info.nombre);
  const trailingHeaders = ['Observacion Audio', 'Resumen', 'Revisor', 'Fecha'];
  const allHeaders = [...fixedHeaders, ...criteriaHeaders, ...trailingHeaders];

  // Set column widths
  const colWidths = [
    5,   // N
    22,  // ID Grabacion
    10,  // Canal
    13,  // Estado
    16,  // Agente
    10,  // Puntaje
    9,   // %
    22,  // Criticos
    ...criteriaList.map(() => 28),
    35,  // Obs Audio
    40,  // Resumen
    16,  // Revisor
    18   // Fecha
  ];
  for (let i = 0; i < colWidths.length; i++) {
    wsSummary.getColumn(i + 1).width = colWidths[i];
  }

  // Header row
  const headerRow = wsSummary.getRow(startRow);
  headerRow.height = 32;
  for (let i = 0; i < allHeaders.length; i++) {
    const cell = headerRow.getCell(i + 1);
    cell.value = allHeaders[i];
    applyHeaderStyle(cell);
  }

  // Mark criteria headers with sub-style to differentiate
  for (let i = fixedHeaders.length; i < fixedHeaders.length + criteriaHeaders.length; i++) {
    const cell = headerRow.getCell(i + 1);
    const info = criteriaList[i - fixedHeaders.length][1];
    cell.font = { name: FONT_MAIN, bold: true, size: 9, color: { argb: COLORS.headerFg } };
    if (info.critico) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '7F1D1D' } }; // dark red for critical
    }
  }

  // Data rows
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const ar = row.agent_result || {};
    const fr = row.filter_result || {};
    const rowNum = startRow + 1 + idx;
    const wsRow = wsSummary.getRow(rowNum);
    wsRow.height = 22;

    const criteriosMap = {};
    if (Array.isArray(ar.criterios)) {
      for (const c of ar.criterios) criteriosMap[c.id] = c;
    }

    const pct = ar.porcentaje != null ? Number(ar.porcentaje) : null;

    const values = [
      idx + 1,
      row.source_id || row.id.substring(0, 8),
      row.channel === 'call' ? 'Llamada' : row.channel === 'email' ? 'Email' : (row.channel || '-'),
      statusLabel(row.status),
      row.assigned_agent || '-',
      ar.puntaje_total != null ? `${ar.puntaje_total}/${ar.puntaje_maximo || '?'}` : '-',
      pct != null ? `${pct.toFixed(1)}%` : '-',
      Array.isArray(ar.puntos_criticos_fallidos) && ar.puntos_criticos_fallidos.length > 0
        ? ar.puntos_criticos_fallidos.join(', ')
        : 'Ninguno',
      ...criteriaList.map(([id]) => {
        const c = criteriosMap[id];
        if (!c) return '-';
        const mark = c.cumple ? 'SI' : 'NO';
        const obs = c.observacion ? ` — ${c.observacion}` : '';
        return `${mark} (${c.puntaje || 0})${obs}`;
      }),
      ar.observacion_audio || '-',
      ar.resumen || '-',
      row.human_reviewer || (row.status === 'aprobado' ? 'Automatico' : '-'),
      fmtDate(row.created_at)
    ];

    for (let i = 0; i < values.length; i++) {
      const cell = wsRow.getCell(i + 1);
      cell.value = values[i];
      applyCellStyle(cell, idx);

      // Column-specific styling
      if (i === 0) { // N
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: COLORS.textMuted } };
      }
      if (i === 3) { // Estado
        const sc = statusColor(row.status);
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: sc.fg } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.bg } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
      if (i === 6 && pct != null) { // %
        const pc = scoreColor(pct);
        cell.font = { name: FONT_MAIN, size: 10, bold: true, color: { argb: pc.fg } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pc.bg } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
      if (i === 5) { // Puntaje
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
      // Criteria columns
      if (i >= fixedHeaders.length && i < fixedHeaders.length + criteriaList.length) {
        const c = criteriosMap[criteriaList[i - fixedHeaders.length][0]];
        if (c) {
          if (c.cumple) {
            cell.font = { name: FONT_MAIN, size: 9, color: { argb: COLORS.success } };
          } else {
            cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: COLORS.danger } };
            if (c.critico) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.dangerBg } };
            }
          }
        }
      }
    }
  }

  // Freeze panes: freeze header row + first 2 columns
  wsSummary.views = [{ state: 'frozen', xSplit: 2, ySplit: startRow, activeCell: 'C' + (startRow + 1) }];

  // Auto-filter
  wsSummary.autoFilter = {
    from: { row: startRow, column: 1 },
    to: { row: startRow + rows.length, column: allHeaders.length }
  };

  // ── Sheet 2: Transcripciones ──
  buildTranscriptSheet(wb, rows);
}

// ─── Legacy (calificacion 1-10) workbook ────────────────────────

async function buildLegacyWorkbook(wb, rows, areaName, dateFrom, dateTo) {
  const ws = wb.addWorksheet('Resumen', {
    properties: { tabColor: { argb: COLORS.brand } }
  });

  const startRow = buildTitleSection(ws, areaName, dateFrom, dateTo, rows);

  const headers = [
    'N', 'ID Grabacion', 'Canal', 'Estado', 'Agente',
    'Calificacion', 'Cumple Protocolo',
    'Resumen', 'Puntos Positivos', 'Puntos Negativos', 'Recomendaciones',
    'Revisor', 'Fecha'
  ];

  const colWidths = [5, 22, 10, 13, 16, 14, 16, 40, 35, 35, 35, 16, 18];
  for (let i = 0; i < colWidths.length; i++) {
    ws.getColumn(i + 1).width = colWidths[i];
  }

  const headerRow = ws.getRow(startRow);
  headerRow.height = 32;
  for (let i = 0; i < headers.length; i++) {
    const cell = headerRow.getCell(i + 1);
    cell.value = headers[i];
    applyHeaderStyle(cell);
  }

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const ar = row.agent_result || {};
    const rowNum = startRow + 1 + idx;
    const wsRow = ws.getRow(rowNum);
    wsRow.height = 22;

    const cal = ar.calificacion != null ? Number(ar.calificacion) : null;

    const values = [
      idx + 1,
      row.source_id || row.id.substring(0, 8),
      row.channel === 'call' ? 'Llamada' : row.channel === 'email' ? 'Email' : (row.channel || '-'),
      statusLabel(row.status),
      row.assigned_agent || '-',
      cal != null ? `${cal}/10` : '-',
      ar.cumple_protocolo ? 'Si' : 'No',
      ar.resumen || '-',
      formatJsonArray(ar.puntos_positivos),
      formatJsonArray(ar.puntos_negativos),
      formatJsonArray(ar.recomendaciones),
      row.human_reviewer || (row.status === 'aprobado' ? 'Automatico' : '-'),
      fmtDate(row.created_at)
    ];

    for (let i = 0; i < values.length; i++) {
      const cell = wsRow.getCell(i + 1);
      cell.value = values[i];
      applyCellStyle(cell, idx);

      if (i === 0) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: COLORS.textMuted } };
      }
      if (i === 3) {
        const sc = statusColor(row.status);
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: sc.fg } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.bg } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
      if (i === 5 && cal != null) {
        const pc = scoreColor(cal * 10);
        cell.font = { name: FONT_MAIN, size: 10, bold: true, color: { argb: pc.fg } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pc.bg } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
      if (i === 6) {
        const cumple = ar.cumple_protocolo;
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: cumple ? COLORS.success : COLORS.danger } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
    }
  }

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: startRow, activeCell: 'C' + (startRow + 1) }];
  ws.autoFilter = {
    from: { row: startRow, column: 1 },
    to: { row: startRow + rows.length, column: headers.length }
  };

  buildTranscriptSheet(wb, rows);
}

// ─── Sheet 2: Transcripciones (shared) ──────────────────────────

function buildTranscriptSheet(wb, rows) {
  const ws = wb.addWorksheet('Transcripciones', {
    properties: { tabColor: { argb: '0EA5E9' } } // sky-500
  });

  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 12;
  ws.getColumn(4).width = 100;
  ws.getColumn(5).width = 30;

  // Header
  const headerRow = ws.getRow(1);
  headerRow.height = 28;
  const tHeaders = ['N', 'ID Grabacion', 'Agente', 'Transcripcion Completa', 'Metricas de Audio'];
  for (let i = 0; i < tHeaders.length; i++) {
    const cell = headerRow.getCell(i + 1);
    cell.value = tHeaders[i];
    applyHeaderStyle(cell);
  }

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const wsRow = ws.getRow(idx + 2);

    const vm = row.voice_metrics;
    let metricsStr = '-';
    if (vm) {
      const m = typeof vm === 'string' ? JSON.parse(vm) : vm;
      const durMin = Math.floor((m.totalDuration || 0) / 60);
      const durSec = (m.totalDuration || 0) % 60;
      const holdMin = Math.floor((m.holdTime || 0) / 60);
      const holdSec = (m.holdTime || 0) % 60;
      metricsStr = `Duracion: ${durMin}m${durSec}s | Habla: ${Math.floor((m.speechTime || 0) / 60)}m | Hold: ${holdMin}m${holdSec}s | Voz elevada: ${m.raisedVoiceMoments || 0} | WPM: ${m.avgWordsPerMinute || 0}`;
    }

    const values = [
      idx + 1,
      row.source_id || row.id.substring(0, 8),
      row.assigned_agent || '-',
      row.raw_text || '-',
      metricsStr
    ];

    for (let i = 0; i < values.length; i++) {
      const cell = wsRow.getCell(i + 1);
      cell.value = values[i];
      applyCellStyle(cell, idx);
      if (i === 3) {
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.font = { name: FONT_MAIN, size: 8, color: { argb: COLORS.textDark } };
      }
      if (i === 4) {
        cell.font = { name: FONT_MAIN, size: 8, color: { argb: COLORS.textMuted } };
        cell.alignment = { vertical: 'top', wrapText: true };
      }
    }
  }

  ws.views = [{ state: 'frozen', ySplit: 1, activeCell: 'A2' }];
}

// ─── Template-based workbook (client's deliverable format) ──────

function parseTemplateColumns(templateText) {
  const lines = templateText.split('\n').filter(l => l.trim() && !l.trim().startsWith('==='));
  if (lines.length === 0) return [];
  const headerLine = lines[0];
  return headerLine.split('|').map(h => h.trim()).filter(Boolean);
}

/**
 * Auto-fill metadata columns that the AI leaves as "-"
 * Maps common column name patterns to interaction data
 */
function autoFillMetadata(colName, row, idx) {
  const cl = colName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Row number
  if (/^(n|nro|no|num|numero|#)$/i.test(cl)) return idx + 1;
  // ID / recording ID
  if (cl.includes('id') && (cl.includes('grab') || cl.includes('llamada') || cl.includes('inter') || cl.includes('caso'))) return row.source_id || row.id.substring(0, 8);
  // Agent name
  if (cl.includes('agente') || cl.includes('asesor') || cl.includes('ejecutivo') || cl.includes('operador')) return row.assigned_agent || '-';
  // Channel
  if (cl.includes('canal') || cl.includes('channel')) return row.channel === 'call' ? 'Llamada' : (row.channel || '-');
  // Status
  if (cl.includes('estado') || cl.includes('status')) return statusLabel(row.status);
  // Date
  if (cl.includes('fecha') || cl.includes('date')) return fmtDate(row.created_at);
  // Reviewer
  if (cl.includes('revisor') || cl.includes('supervisor') || cl.includes('monitor')) return row.human_reviewer || (row.status === 'aprobado' ? 'Automatico' : '-');
  return null; // no match — use AI value
}

async function buildTemplateWorkbook(wb, rows, areaName, dateFrom, dateTo, templateText) {
  const ws = wb.addWorksheet('Entregable', {
    properties: { tabColor: { argb: COLORS.brand } }
  });

  const columns = parseTemplateColumns(templateText);
  if (columns.length === 0) {
    // Fallback to v2 if template can't be parsed
    return buildV2Workbook(wb, rows, areaName, dateFrom, dateTo);
  }

  // Title section — adjust merge width to column count
  const mergeEnd = String.fromCharCode(64 + Math.min(columns.length, 26)); // A=65, max Z
  ws.mergeCells(`A1:${mergeEnd}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = 'NEUROCHAT B2B — REPORTE DE CALIDAD';
  titleCell.font = { name: FONT_MAIN, bold: true, size: 16, color: { argb: COLORS.headerFg } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.brand } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 40;

  ws.mergeCells(`A2:${mergeEnd}2`);
  const subCell = ws.getCell('A2');
  subCell.value = `Area: ${areaName}  |  Periodo: ${fmtDateShort(dateFrom)} — ${fmtDateShort(dateTo)}`;
  subCell.font = { name: FONT_MAIN, size: 11, color: { argb: COLORS.subHeaderFg } };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(2).height = 28;

  // Stats row
  const approved = rows.filter(r => r.status === 'aprobado').length;
  const review = rows.filter(r => r.status === 'en_revision').length;
  const rejected = rows.filter(r => r.status === 'rechazado').length;
  let avgScore = 0, scoreCount = 0;
  for (const r of rows) {
    const ar = r.agent_result || {};
    if (ar.porcentaje != null) { avgScore += Number(ar.porcentaje); scoreCount++; }
  }
  avgScore = scoreCount > 0 ? (avgScore / scoreCount).toFixed(1) : '-';

  ws.mergeCells(`A3:${mergeEnd}3`);
  const statsCell = ws.getCell('A3');
  statsCell.value = `Total: ${rows.length} registros  |  Aprobados: ${approved}  |  En revision: ${review}  |  Rechazados: ${rejected}  |  Puntaje promedio: ${avgScore}%`;
  statsCell.font = { name: FONT_MAIN, size: 10, color: { argb: COLORS.brand } };
  statsCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.brandLight } };
  statsCell.alignment = { vertical: 'middle', horizontal: 'center' };
  statsCell.border = { bottom: { style: 'medium', color: { argb: COLORS.brand } } };
  ws.getRow(3).height = 26;
  ws.getRow(4).height = 8; // separator

  const startRow = 5;

  // Column widths — smart sizing based on column name
  for (let i = 0; i < columns.length; i++) {
    const cl = columns[i].toLowerCase();
    let w = Math.max(columns[i].length + 4, 15);
    if (/^(n|nro|no|#)$/i.test(cl)) w = 5;
    else if (cl.includes('resumen') || cl.includes('observa') || cl.includes('recomend')) w = 40;
    else if (cl.includes('id') || cl.includes('grab')) w = 22;
    ws.getColumn(i + 1).width = w;
  }

  // Header row — exact columns from client template
  const headerRow = ws.getRow(startRow);
  headerRow.height = 32;
  for (let i = 0; i < columns.length; i++) {
    const cell = headerRow.getCell(i + 1);
    cell.value = columns[i];
    applyHeaderStyle(cell);
  }

  // Data rows
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const ar = row.agent_result || {};
    const entregable = ar.entregable || {};
    const rowNum = startRow + 1 + idx;
    const wsRow = ws.getRow(rowNum);
    wsRow.height = 22;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const cell = wsRow.getCell(i + 1);

      // Priority: 1) auto-fill metadata, 2) AI entregable value, 3) fallback "-"
      const metaValue = autoFillMetadata(col, row, idx);
      let value;
      if (metaValue !== null) {
        value = metaValue;
      } else {
        value = entregable[col] !== undefined ? entregable[col] : '-';
      }

      cell.value = value;
      applyCellStyle(cell, idx);

      // Color coding for common patterns
      const strVal = String(value).toLowerCase();
      if (strVal === 'cumple' || strVal === 'si' || strVal === 'sí') {
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: COLORS.success } };
      } else if (strVal === 'no cumple' || strVal === 'no') {
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: COLORS.danger } };
      }

      // Score/percentage columns — color by value
      const numVal = parseFloat(value);
      if (!isNaN(numVal) && col.toLowerCase().includes('puntaje') || col.toLowerCase().includes('porcentaje') || col.toLowerCase().includes('calificacion') || col.toLowerCase().includes('%')) {
        const pct = col.toLowerCase().includes('%') || col.toLowerCase().includes('porcentaje') ? numVal : numVal * 10;
        if (pct >= 0) {
          const pc = scoreColor(pct);
          cell.font = { name: FONT_MAIN, size: 10, bold: true, color: { argb: pc.fg } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pc.bg } };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        }
      }
    }
  }

  // Freeze header + first 2 columns
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: startRow, activeCell: 'C' + (startRow + 1) }];
  ws.autoFilter = {
    from: { row: startRow, column: 1 },
    to: { row: startRow + rows.length, column: columns.length }
  };

  // Still include transcriptions sheet
  buildTranscriptSheet(wb, rows);
}

// ─── Auto-entregable workbook (columns from AI's entregable keys) ──

async function buildAutoEntregableWorkbook(wb, rows, areaName, dateFrom, dateTo) {
  // Collect all unique entregable keys across all interactions
  const allKeys = new Set();
  for (const row of rows) {
    const entregable = row.agent_result?.entregable;
    if (entregable && typeof entregable === 'object') {
      for (const key of Object.keys(entregable)) allKeys.add(key);
    }
  }

  // Build column list: metadata + entregable criteria + trailing
  const metaCols = ['N', 'ID Grabacion', 'Canal', 'Agente', 'Estado'];
  const criteriaCols = Array.from(allKeys);
  const trailingCols = ['Puntaje', '%', 'Resumen', 'Revisor', 'Fecha'];
  const columns = [...metaCols, ...criteriaCols, ...trailingCols];

  const ws = wb.addWorksheet('Entregable', {
    properties: { tabColor: { argb: COLORS.brand } }
  });

  const mergeEnd = String.fromCharCode(64 + Math.min(columns.length, 26));

  // Title section
  ws.mergeCells(`A1:${mergeEnd}1`);
  const titleCell = ws.getCell('A1');
  titleCell.value = 'NEUROCHAT B2B — REPORTE DE CALIDAD';
  titleCell.font = { name: FONT_MAIN, bold: true, size: 16, color: { argb: COLORS.headerFg } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.brand } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 40;

  ws.mergeCells(`A2:${mergeEnd}2`);
  const subCell = ws.getCell('A2');
  subCell.value = `Area: ${areaName}  |  Periodo: ${fmtDateShort(dateFrom)} — ${fmtDateShort(dateTo)}`;
  subCell.font = { name: FONT_MAIN, size: 11, color: { argb: COLORS.subHeaderFg } };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(2).height = 28;

  // Stats
  const approved = rows.filter(r => r.status === 'aprobado').length;
  const review = rows.filter(r => r.status === 'en_revision').length;
  const rejected = rows.filter(r => r.status === 'rechazado').length;
  let avgScore = 0, scoreCount = 0;
  for (const r of rows) {
    if (r.agent_result?.porcentaje != null) { avgScore += Number(r.agent_result.porcentaje); scoreCount++; }
  }
  avgScore = scoreCount > 0 ? (avgScore / scoreCount).toFixed(1) : '-';

  ws.mergeCells(`A3:${mergeEnd}3`);
  const statsCell = ws.getCell('A3');
  statsCell.value = `Total: ${rows.length}  |  Aprobados: ${approved}  |  En revision: ${review}  |  Rechazados: ${rejected}  |  Puntaje promedio: ${avgScore}%`;
  statsCell.font = { name: FONT_MAIN, size: 10, color: { argb: COLORS.brand } };
  statsCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.brandLight } };
  statsCell.alignment = { vertical: 'middle', horizontal: 'center' };
  statsCell.border = { bottom: { style: 'medium', color: { argb: COLORS.brand } } };
  ws.getRow(3).height = 26;
  ws.getRow(4).height = 8;

  const startRow = 5;

  // Column widths
  for (let i = 0; i < columns.length; i++) {
    const cl = columns[i].toLowerCase();
    let w = Math.max(columns[i].length + 4, 18);
    if (cl === 'n') w = 5;
    else if (cl.includes('resumen') || cl.includes('observa')) w = 40;
    else if (cl.includes('id')) w = 22;
    else if (cl === '%' || cl === 'puntaje') w = 10;
    else if (criteriaCols.includes(columns[i])) w = 30; // criteria columns wider
    ws.getColumn(i + 1).width = w;
  }

  // Header row
  const headerRow = ws.getRow(startRow);
  headerRow.height = 32;
  for (let i = 0; i < columns.length; i++) {
    const cell = headerRow.getCell(i + 1);
    cell.value = columns[i];
    applyHeaderStyle(cell);
  }

  // Data rows
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const ar = row.agent_result || {};
    const entregable = ar.entregable || {};
    const rowNum = startRow + 1 + idx;
    const wsRow = ws.getRow(rowNum);
    wsRow.height = 22;

    const pct = ar.porcentaje != null ? Number(ar.porcentaje) : null;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const cell = wsRow.getCell(i + 1);
      let value;

      // Metadata columns
      if (col === 'N') value = idx + 1;
      else if (col === 'ID Grabacion') value = row.source_id || row.id.substring(0, 8);
      else if (col === 'Canal') value = row.channel === 'call' ? 'Llamada' : (row.channel || '-');
      else if (col === 'Agente') value = row.assigned_agent || '-';
      else if (col === 'Estado') value = statusLabel(row.status);
      else if (col === 'Puntaje') value = ar.puntaje_total != null ? `${ar.puntaje_total}/${ar.puntaje_maximo || '?'}` : '-';
      else if (col === '%') value = pct != null ? `${pct.toFixed(1)}%` : '-';
      else if (col === 'Resumen') value = ar.resumen || '-';
      else if (col === 'Revisor') value = row.human_reviewer || (row.status === 'aprobado' ? 'Automatico' : '-');
      else if (col === 'Fecha') value = fmtDate(row.created_at);
      // Criteria columns from entregable
      else value = entregable[col] !== undefined ? entregable[col] : '-';

      cell.value = value;
      applyCellStyle(cell, idx);

      // Color coding
      const strVal = String(value).toLowerCase();
      if (strVal.startsWith('cumple') && !strVal.startsWith('cumple parcial')) {
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: COLORS.success } };
      } else if (strVal.startsWith('no cumple')) {
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: COLORS.danger } };
      } else if (strVal.startsWith('cumple parcial')) {
        cell.font = { name: FONT_MAIN, size: 9, bold: true, color: { argb: COLORS.warning } };
      }

      // % column color
      if (col === '%' && pct != null) {
        const pc = scoreColor(pct);
        cell.font = { name: FONT_MAIN, size: 10, bold: true, color: { argb: pc.fg } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pc.bg } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
    }
  }

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: startRow, activeCell: 'C' + (startRow + 1) }];
  ws.autoFilter = {
    from: { row: startRow, column: 1 },
    to: { row: startRow + rows.length, column: columns.length }
  };

  buildTranscriptSheet(wb, rows);
}

// ─── Utility ────────────────────────────────────────────────────

function formatJsonArray(value) {
  if (!value) return '-';
  if (Array.isArray(value)) return value.join('; ');
  try {
    const arr = JSON.parse(value);
    if (Array.isArray(arr)) return arr.join('; ');
    return String(arr);
  } catch {
    return String(value);
  }
}

module.exports = { generateExcel };

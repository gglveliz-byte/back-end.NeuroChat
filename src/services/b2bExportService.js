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
       i.agent_results,
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

  // Expand multi-agent rows: if agent_results has multiple entries, create one row per advisor
  let rows = result.rows;
  const expandedRows = [];
  for (const row of rows) {
    const agentResults = row.agent_results;
    if (Array.isArray(agentResults) && agentResults.length > 1) {
      for (const ar of agentResults) {
        expandedRows.push({
          ...row,
          agent_result: ar.result,
          _evaluated_agent: ar.agent_label,
          _multi_agent: true
        });
      }
    } else {
      expandedRows.push({ ...row, _evaluated_agent: null, _multi_agent: false });
    }
  }
  rows = expandedRows;
  const hasMultiAgent = rows.some(r => r._multi_agent);

  const hasV2 = rows.some(r => r.agent_result && Array.isArray(r.agent_result.criterios));

  // Fetch ALL agent templates for the area (each agent may have a different template)
  const agentTemplateResult = await query(
    `SELECT ag.name, ag.deliverable_template
     FROM b2b_agents ag
     WHERE ag.b2b_area_id = $1 AND ag.type = 'specialized' AND ag.is_active = true
       AND ag.deliverable_template IS NOT NULL AND ag.deliverable_template != ''`,
    [areaId]
  );
  // Map agent name → deliverable_template for per-interaction matching
  const agentTemplateMap = {};
  for (const at of agentTemplateResult.rows) {
    agentTemplateMap[at.name.toLowerCase()] = at.deliverable_template;
  }
  // Use the first available as default fallback
  const deliverableTemplate = agentTemplateResult.rows[0]?.deliverable_template;
  const hasEntregable = rows.some(r => r.agent_result?.entregable && typeof r.agent_result.entregable === 'object' && !Array.isArray(r.agent_result.entregable) && Object.keys(r.agent_result.entregable).length > 0);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'NeuroChat B2B';
  wb.created = new Date();

  if (deliverableTemplate && hasV2) {
    // Use client's deliverable template — build entregable from criterios if needed
    await buildTemplateWorkbook(wb, rows, areaName, dateFrom, dateTo, deliverableTemplate, agentTemplateMap);
  } else if (hasEntregable && deliverableTemplate) {
    await buildTemplateWorkbook(wb, rows, areaName, dateFrom, dateTo, deliverableTemplate, agentTemplateMap);
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
    const v2AgentDisplay = row._evaluated_agent ? `${row.assigned_agent || '-'} (${row._evaluated_agent})` : (row.assigned_agent || '-');

    const values = [
      idx + 1,
      row.source_id || row.id.substring(0, 8),
      row.channel === 'call' ? 'Llamada' : row.channel === 'email' ? 'Email' : (row.channel || '-'),
      statusLabel(row.status),
      v2AgentDisplay,
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
    const legacyAgentDisplay = row._evaluated_agent ? `${row.assigned_agent || '-'} (${row._evaluated_agent})` : (row.assigned_agent || '-');

    const values = [
      idx + 1,
      row.source_id || row.id.substring(0, 8),
      row.channel === 'call' ? 'Llamada' : row.channel === 'email' ? 'Email' : (row.channel || '-'),
      statusLabel(row.status),
      legacyAgentDisplay,
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

// ─── Entregable builder from criterios ──────────────────────────

/**
 * Normalize a string for fuzzy matching: lowercase, remove accents, trim
 */
function normalizeForMatch(str) {
  return String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/**
 * Aggressive normalize: also remove common Spanish filler words for fuzzy column matching
 */
function normalizeAggressive(str) {
  return normalizeForMatch(str).replace(/\b(de|del|la|las|los|el|en|y|con|por|para|al|a)\b/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Match a deliverable template column name to a criterion from agent_result.criterios.
 * Uses substring matching since template columns use short names
 * (e.g., "Saludo y presentación") while criterios use full names
 * (e.g., "Etiqueta Telefónica - Saludo y presentación").
 */
function matchCriterionToColumn(colName, criterios) {
  if (!criterios || !Array.isArray(criterios)) return null;
  const normCol = normalizeForMatch(colName);
  if (!normCol || normCol.length < 3) return null;

  // 1. Exact match on nombre
  let match = criterios.find(c => normalizeForMatch(c.nombre) === normCol);
  if (match) return match;

  // 2. Column name is contained in criterion nombre (e.g., "Tono y voz" in "Etiqueta Telefónica - Tono de Voz")
  match = criterios.find(c => normalizeForMatch(c.nombre).includes(normCol));
  if (match) return match;

  // 3. Criterion nombre is contained in column name
  match = criterios.find(c => {
    const normNombre = normalizeForMatch(c.nombre);
    return normNombre.length >= 5 && normCol.includes(normNombre);
  });
  if (match) return match;

  // 4. Fuzzy: compare the last part after " - " (the specific criterion)
  match = criterios.find(c => {
    const nombre = c.nombre || '';
    const parts = nombre.split(' - ');
    if (parts.length > 1) {
      const specific = normalizeForMatch(parts[parts.length - 1]);
      return specific.length >= 5 && (normCol.includes(specific) || specific.includes(normCol));
    }
    return false;
  });
  if (match) return match;

  // 5. Aggressive: strip filler words (de, en, la, etc.) and retry
  const aggCol = normalizeAggressive(colName);
  if (aggCol.length >= 5) {
    match = criterios.find(c => {
      const aggNombre = normalizeAggressive(c.nombre);
      return aggNombre.includes(aggCol) || aggCol.includes(aggNombre);
    });
    if (match) return match;

    // Also try aggressive on the specific part after " - "
    match = criterios.find(c => {
      const parts = (c.nombre || '').split(' - ');
      if (parts.length > 1) {
        const aggSpecific = normalizeAggressive(parts[parts.length - 1]);
        return aggSpecific.length >= 5 && (aggCol.includes(aggSpecific) || aggSpecific.includes(aggCol));
      }
      return false;
    });
    if (match) return match;
  }

  return null;
}

/**
 * Fuzzy lookup a value from an object using normalized key matching.
 * Handles accent, case, and whitespace differences between template columns and AI keys.
 */
function fuzzyLookup(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  // 1. Exact match
  if (obj[key] !== undefined) return obj[key];
  // 2. Normalized match
  const normKey = normalizeForMatch(key);
  for (const k of Object.keys(obj)) {
    if (normalizeForMatch(k) === normKey) return obj[k];
  }
  // 3. Substring match (template col is shorter name of AI key or vice versa)
  if (normKey.length >= 5) {
    for (const k of Object.keys(obj)) {
      const normK = normalizeForMatch(k);
      if (normK.length >= 5 && (normK.includes(normKey) || normKey.includes(normK))) return obj[k];
    }
  }
  return undefined;
}

/**
 * Build entregable object from criterios + deliverable template columns.
 * Returns { colName: "SI"/"NO"/value } for each non-metadata column.
 */
function buildEntregableFromCriterios(row, columns) {
  const ar = row.agent_result || {};
  const criterios = ar.criterios || [];
  const entregable = {};

  // Track which criterios have been matched to avoid double-matching
  const matchedCriterioIds = new Set();

  for (const col of columns) {
    // Skip metadata columns (autoFillMetadata handles these)
    if (autoFillMetadata(col, row, 0) !== null) continue;

    const normCol = normalizeForMatch(col);

    // Special columns
    if (normCol.includes('puntaje') || normCol === '%' || normCol.includes('porcentaje') || normCol.includes('calificacion')) {
      // Show percentage for general score columns
      entregable[col] = ar.porcentaje != null ? `${Number(ar.porcentaje).toFixed(1)}%` : '-';
      continue;
    }
    if (normCol.includes('comentario') || normCol.includes('observacion') || normCol.includes('resumen')) {
      entregable[col] = ar.resumen || ar.observaciones_autonomas || '-';
      continue;
    }
    if (normCol.includes('motivo') && normCol.includes('monitoreo')) {
      entregable[col] = row.filter_result?.categoria || row.assigned_agent || '-';
      continue;
    }
    if (normCol.includes('cuenta') || normCol.includes('numero de cuenta')) {
      entregable[col] = row.source_id || '-';
      continue;
    }
    if (normCol.includes('momento') && normCol.includes('verdad')) {
      entregable[col] = row.filter_result?.categoria || '-';
      continue;
    }
    if (normCol.includes('usuario') && normCol.includes('asesor')) {
      entregable[col] = row.assigned_agent || '-';
      continue;
    }
    if (normCol.includes('etiqueta') && normCol.includes('color')) {
      const pct = ar.porcentaje;
      if (pct != null) {
        entregable[col] = pct >= 80 ? 'Verde' : pct >= 50 ? 'Amarillo' : 'Rojo';
      } else {
        entregable[col] = '-';
      }
      continue;
    }

    // Try to match to a criterion
    // Filter out already matched criterios to handle duplicates in template
    const availableCriterios = criterios.filter(c => !matchedCriterioIds.has(c.id));
    let criterion = matchCriterionToColumn(col, availableCriterios);

    // If no match in available, try all criterios
    if (!criterion) criterion = matchCriterionToColumn(col, criterios);

    // Fallback: try matching by positional order (column position maps to criterion order)
    if (!criterion && criterios.length > 0) {
      const nonMetaCols = columns.filter(c => autoFillMetadata(c, row, 0) === null
        && !normalizeForMatch(c).includes('puntaje') && !normalizeForMatch(c).includes('porcentaje')
        && !normalizeForMatch(c).includes('calificacion') && normalizeForMatch(c) !== '%'
        && !normalizeForMatch(c).includes('comentario') && !normalizeForMatch(c).includes('observacion')
        && !normalizeForMatch(c).includes('resumen') && !normalizeForMatch(c).includes('etiqueta')
        && !normalizeForMatch(c).includes('motivo') && !normalizeForMatch(c).includes('momento')
        && !normalizeForMatch(c).includes('usuario') && !normalizeForMatch(c).includes('cuenta')
      );
      const colIdx = nonMetaCols.indexOf(col);
      if (colIdx >= 0 && colIdx < criterios.length) {
        criterion = criterios[colIdx];
      }
    }

    if (criterion) {
      entregable[col] = criterion.cumple ? 'SI' : 'NO';
      if (criterion.id != null) matchedCriterioIds.add(criterion.id);
    } else {
      entregable[col] = '-';
    }
  }

  return entregable;
}

// ─── Template-based workbook (client's deliverable format) ──────

function parseTemplateColumns(templateText) {
  const lines = templateText.split('\n').filter(l => l.trim() && !l.trim().startsWith('===') && !l.trim().match(/^[-|\s]+$/));
  if (lines.length === 0) return [];
  const headerLine = lines[0];
  const allCols = headerLine.split('|').map(h => h.trim()).filter(Boolean);

  // Filter out SharePoint/system metadata columns that are not relevant to evaluation
  const JUNK_PATTERNS = [
    /^id\.?\s*de\s*activo/i, /^tipo\s*de\s*contenido/i, /^modificado$/i,
    /^created$/i, /^author$/i, /^modificado\s*por$/i, /^versi[oó]n$/i,
    /^datos\s*adjuntos$/i, /^editar$/i, /^tipo$/i, /^n[uú]mero\s*secundario/i,
    /^recuento\s*secundario/i, /^configuraci[oó]n\s*de\s*la\s*etiqueta$/i,
    /^etiqueta\s*de\s*retenci[oó]n/i, /^usuario\s*que\s*ha\s*aplicado/i,
    /^el\s*elemento\s*es/i, /^aplicaci[oó]n\s*creada/i, /^aplicaci[oó]n\s*modificada/i,
    /^field_\d+$/i, /^cumplimiento\s*normativo/i
  ];

  return allCols.filter(col => {
    const norm = col.trim();
    if (!norm) return false;
    // Only filter junk if columns > 20 (clearly has SharePoint metadata mixed in)
    if (allCols.length > 20) {
      return !JUNK_PATTERNS.some(p => p.test(norm));
    }
    return true;
  });
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
  // Just "ID" alone
  if (/^id$/i.test(cl.trim())) return row.source_id || row.id.substring(0, 8);
  // Asesor Evaluado (multi-agent: which advisor was evaluated in this row)
  if (cl.includes('asesor evaluado') || cl.includes('evaluado')) return row._evaluated_agent || '-';
  // Agent name — if multi-agent, append which advisor
  if (cl.includes('agente') || cl.includes('asesor') || cl.includes('ejecutivo') || cl.includes('operador')) {
    const base = row.assigned_agent || '-';
    return row._evaluated_agent ? `${base} (${row._evaluated_agent})` : base;
  }
  // Title (often = agent/evaluator name or interaction title)
  if (/^title$/i.test(cl.trim())) return row.assigned_agent || '-';
  // Channel
  if (cl.includes('canal') || cl.includes('channel')) return row.channel === 'call' ? 'Llamada' : (row.channel || '-');
  // Status
  if (cl.includes('estado') || cl.includes('status')) return statusLabel(row.status);
  // Date (general or specific patterns)
  if (/^fecha$/i.test(cl.trim()) || cl.includes('fecha monitoreo') || cl.includes('date')) return fmtDate(row.created_at);
  // Reviewer / evaluator / monitor name (exclude "monitoreo" which is monitoring reason, not reviewer)
  if (cl.includes('revisor') || cl.includes('supervisor') || (cl.includes('monitor') && !cl.includes('monitoreo')) || cl.includes('evaluador') || cl.includes('nombre del evaluador')) return row.human_reviewer || (row.status === 'aprobado' ? 'Automatico' : '-');
  // Account number
  if (cl.includes('cuenta') && !cl.includes('recuento')) return row.source_id || '-';
  return null; // no match — use AI value
}

async function buildTemplateWorkbook(wb, rows, areaName, dateFrom, dateTo, templateText, agentTemplateMap = {}) {
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
    // Use AI entregable if it's a valid object with matching keys; otherwise build from criterios
    let entregable = {};
    const aiEntregable = ar.entregable;
    if (aiEntregable && typeof aiEntregable === 'object' && !Array.isArray(aiEntregable)) {
      // Check if AI entregable has at least some matching column keys
      const aiKeys = Object.keys(aiEntregable);
      const matchCount = aiKeys.filter(k => columns.some(c => normalizeForMatch(c) === normalizeForMatch(k))).length;
      if (matchCount >= 2) {
        entregable = aiEntregable;
      }
    }
    // If AI entregable is empty/bad, build from criterios
    if (Object.keys(entregable).length === 0 && Array.isArray(ar.criterios) && ar.criterios.length > 0) {
      // Use per-agent template if available (different agents may have different column mappings)
      const agentKey = (row.assigned_agent || '').toLowerCase();
      const agentTemplate = agentTemplateMap[agentKey];
      const agentColumns = agentTemplate ? parseTemplateColumns(agentTemplate) : columns;
      entregable = buildEntregableFromCriterios(row, agentColumns);
    }
    const rowNum = startRow + 1 + idx;
    const wsRow = ws.getRow(rowNum);
    wsRow.height = 22;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const cell = wsRow.getCell(i + 1);

      // Priority: 1) auto-fill metadata, 2) built entregable value (fuzzy key match), 3) fallback "-"
      const metaValue = autoFillMetadata(col, row, idx);
      let value;
      if (metaValue !== null) {
        value = metaValue;
      } else {
        // Use fuzzy lookup to handle accent/case mismatches between template cols and entregable keys
        const entVal = fuzzyLookup(entregable, col);
        value = entVal !== undefined ? entVal : '-';
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
      // Criteria columns from entregable (fuzzy key match)
      else {
        const entVal = fuzzyLookup(entregable, col);
        value = entVal !== undefined ? entVal : '-';
      }

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

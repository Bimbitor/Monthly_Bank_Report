/**
 * @fileoverview ETL Pipeline para Análisis Financiero Personal.
 * @version 11.0.0
 * @author Javi Giraldo (Adaptado para GitHub)
 * @description Extrae notificaciones bancarias de Gmail, transforma los datos no estructurados
 * y carga métricas consolidadas en Google Sheets y reportes PDF.
 */

// ==========================================
// 1. CONFIGURACIÓN DEL ENTORNO
// ==========================================
/**
 * Configuración global del ETL.
 * @const {Object}
 * NOTA: Para mayor seguridad en producción, usar 'PropertiesService' de Apps Script.
 */
const CONFIG = {
  // Query de búsqueda en Gmail (Personalizar según el banco)
  SEARCH_QUERY: 'subject:"Alertas y Notificaciones" from:"alertas@banco.com"', 
  
  // Destinatarios del reporte
  EMAIL_TO: "tu_email@ejemplo.com", 
  EMAIL_CC: "", // Opcional
  
  // Configuración de almacenamiento
  SHEET_NAME: "BankData_Produccion",
  
  // Ventana de tiempo (Opcional: Ajustar timezone)
  TIMEZONE: "GMT-5"
};

/**
 * Función Principal (Orquestador).
 * Ejecuta el pipeline ETL completo.
 */
function runFinancialETL() {
  Logger.log(">> Iniciando Pipeline ETL Financiero...");

  // 1. EXTRACTION (Extract)
  const rawData = extractBankData();
  
  // Validación de datos (Early Exit)
  if (!rawData.transactions || rawData.transactions.length === 0) {
    Logger.log("[INFO] No se detectaron transacciones en el periodo actual. Proceso finalizado.");
    return;
  }
  
  // 2. LOAD (Load to Sheets)
  updateSheetMetrics(rawData);
  
  // 3. REPORTING (Load to PDF/Email)
  distributeReport(rawData.summary);
  
  Logger.log(">> Pipeline finalizado exitosamente.");
}

/**
 * Módulo de Extracción.
 * Busca correos mediante Gmail API y parsea el cuerpo usando RegEx.
 * @return {Object} Objeto con transacciones detalladas y resumen.
 */
function extractBankData() {
  const now = new Date();
  // Ventana de tiempo: Mes actual completo
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  
  // Conversión a Epoch Timestamp para filtros de Gmail
  const after = Math.floor(startMonth.getTime() / 1000);
  const before = Math.floor(endMonth.getTime() / 1000);
  
  const query = `${CONFIG.SEARCH_QUERY} after:${after} before:${before}`;
  const threads = GmailApp.search(query);
  const messages = GmailApp.getMessagesForThreads(threads);
  
  let transactions = [];
  let totalSpent = 0;
  let categoryMap = {};

  // REGEX PATTERN
  // ADVERTENCIA: Este patrón está ajustado para notificaciones de Bancolombia/Bold.
  // Modificar según el formato del correo de tu banco.
  const regexCompra = /Compraste\s+\$([\d.,]+)\s+en\s+(.+?)\s+con\s+tu\s+T\.Deb/i;

  messages.forEach(thread => {
    thread.forEach(msg => {
      const body = msg.getPlainBody();
      const match = body.match(regexCompra);
      
      if (match) {
        // TRANSFORMACIÓN DE DATOS
        let rawAmount = match[1]; 
        let merchant = match[2].trim();
        let date = msg.getDate();
        
        // Limpieza de moneda (Manejo de localización CO)
        let amount = parseFloat(rawAmount.replace(/\./g, '').replace(',', '.'));
        
        if (!isNaN(amount)) {
          transactions.push({ date, merchant, amount });
          totalSpent += amount;
          
          // Agregación simple
          categoryMap[merchant] = (categoryMap[merchant] || 0) + amount;
        }
      }
    });
  });
  
  // Ordenamiento cronológico ascendente
  transactions.sort((a, b) => a.date - b.date);

  return {
    transactions: transactions,
    summary: {
      total: totalSpent,
      categories: categoryMap,
      monthName: startMonth.toLocaleString('es-CO', { month: 'long' }).toUpperCase(),
      year: startMonth.getFullYear()
    }
  };
}

/**
 * Módulo de Carga en Spreadsheet.
 * Renderiza los datos para persistencia y generación de PDF.
 * @param {Object} data - Datos transformados del módulo de extracción.
 */
function updateSheetMetrics(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }
  
  sheet.clear();
  
  // Definición de Schema Visual
  const headers = [["FECHA", "COMERCIO / CONCEPTO", "VALOR", "CATEGORÍA"]];
  const headerRange = sheet.getRange("A1:D1");
  
  headerRange.setValues(headers)
             .setFontWeight("bold")
             .setBackground("#2c3e50") // Dark Blue Professional
             .setFontColor("#ecf0f1");
  
  // Mapeo de datos a filas
  const rows = data.transactions.map(t => [
    t.date,
    t.merchant,
    t.amount,
    "Gasto Variable" // Placeholder para futura lógica de clasificación ML
  ]);
  
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 4).setValues(rows);
    sheet.getRange(2, 3, rows.length, 1).setNumberFormat("$ #,##0.00"); // Formato Financiero
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat("yyyy-MM-dd HH:mm"); // ISO-like format
  }
  
  // KPI Dashboard (Panel Lateral)
  sheet.getRange("F2").setValue("TOTAL MENSUAL (KPI):").setFontWeight("bold");
  sheet.getRange("F3").setValue(data.summary.total)
                      .setNumberFormat("$ #,##0.00")
                      .setFontWeight("bold")
                      .setFontColor("#c0392b"); // Alerta visual
  
  sheet.autoResizeColumns(1, 6);
}

/**
 * Módulo de Distribución.
 * Genera el snapshot en PDF y notifica vía Email.
 * @param {Object} summary - Resumen ejecutivo para el cuerpo del correo.
 */
function distributeReport(summary) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const fechaReporte = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd");
  const emailSubject = `[FINANCE-BOT] Reporte Mensual: ${summary.monthName} ${summary.year}`;
  
  const pdfBlob = ss.getAs('application/pdf').setName(`Financial_Report_${summary.monthName}_${summary.year}.pdf`);
  
  // Construcción del reporte (Template String)
  const emailBody = 
    `REPORTE AUTOMATIZADO DE INGENIERÍA DE COSTOS\n` +
    `============================================\n` +
    `Fecha de ejecución: ${fechaReporte}\n` +
    `Periodo: ${summary.monthName} ${summary.year}\n\n` +
    `RESUMEN EJECUTIVO (METRICS):\n` +
    `--------------------------------------------\n` +
    `> Total Procesado:   $${summary.total.toLocaleString('es-CO')}\n` +
    `> Transacciones:     ${Object.keys(summary.categories).length} comercios únicos.\n\n` +
    `El desglose detallado se encuentra adjunto en formato PDF.\n\n` +
    `--\n` +
    `Automated via Google Apps Script | Data Engineering Pipeline`;

  const emailOptions = {
    attachments: [pdfBlob],
    name: "Financial Data Pipeline",
  };
  
  if (CONFIG.EMAIL_CC) {
    emailOptions.cc = CONFIG.EMAIL_CC;
  }

  GmailApp.sendEmail(CONFIG.EMAIL_TO, emailSubject, emailBody, emailOptions);
}

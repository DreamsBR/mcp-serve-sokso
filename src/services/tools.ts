import { poolManager } from "./db.js";
import { fetchAWSLogs } from "./aws.js";
import { DateTime } from "luxon";
import fs from "fs";
import path from "path";

// Ensure exports directory exists
const EXPORTS_DIR = path.join(process.cwd(), "exports");
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR);
}

export async function scanBackorders(dbName: string = "default", limit: number = 50) {
  try {
    const pool = await poolManager.getPool(dbName);
    // Optimized SQL Query
    const query = `
      SELECT 
        "sIdPedidoDetalle" as id,
        "sSkuProducto" as sku,
        "dtFechaPedido" as fecha,
        "nCantidad" as qty,
        "nCantidadComprometida" as committed
      FROM pedidos_detalle
      WHERE 
        "sEstadoEnvioNetsuite" = 'ENVIADO' 
        AND "sAccionDirectora" = 'CONFIRMADO' 
        AND CAST("nCantidad" AS NUMERIC) > CAST("nCantidadComprometida" AS NUMERIC)
      LIMIT $1
    `;
    
    const result = await pool.query(query, [limit]);
    return {
      count: result.rowCount,
      note: "Showing top results only. Use these IDs to check logs.",
      data: result.rows
    };
  } catch (error: any) {
    throw new Error(`Error scanning backorders: ${error.message}`);
  }
}

export async function analyzeOrdersInLogs(orders: any[], logGroupNames: string[]) {
  const results = [];
  
  // Limit to 5 orders to prevent token explosion
  const ordersToProcess = orders.slice(0, 5); 

  for (const order of ordersToProcess) {
    const id = order.id || order.sIdPedidoDetalle;
    const date = order.fecha || order.dtFechaPedido;
    
    if (!date) continue;

    const start = DateTime.fromISO(date).minus({ minutes: 5 }).toFormat('yyyy-MM-dd HH:mm:ss');
    const end = DateTime.fromISO(date).plus({ minutes: 30 }).toFormat('yyyy-MM-dd HH:mm:ss');

    const orderLogs = [];
    for (const group of logGroupNames) {
      const logs = await fetchAWSLogs(group, start, end, `"${id}"`);
      if (logs.length > 0) {
        orderLogs.push({ group, entries: logs });
      }
    }
    results.push({ orderId: id, logs: orderLogs });
  }

  return results;
}

export async function runQuery(dbName: string, query: string) {
  if (!query.trim().toLowerCase().startsWith("select")) {
    throw new Error("Only SELECT allowed");
  }
  const pool = await poolManager.getPool(dbName);
  const res = await pool.query(query);
  
  const MAX_INLINE_ROWS = 50;

  // Strategy: Auto-Export to CSV if result is large
  if (res.rows.length > MAX_INLINE_ROWS) {
    const timestamp = DateTime.now().toFormat("yyyyMMdd_HHmmss");
    const filename = `query_result_${timestamp}.csv`;
    const filePath = path.join(EXPORTS_DIR, filename);
    
    // Convert to CSV simple implementation
    const headers = res.fields.map(f => f.name).join(",");
    const rows = res.rows.map(row => {
      return Object.values(row).map(val => {
        if (val === null) return "";
        if (typeof val === "object") return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        return `"${String(val).replace(/"/g, '""')}"`;
      }).join(",");
    }).join("\n");
    
    const csvContent = `${headers}\n${rows}`;
    fs.writeFileSync(filePath, csvContent);

    return {
      status: "partial_content",
      message: `Result contains ${res.rows.length} rows, which exceeds the display limit.`,
      action_taken: `Data has been automatically exported to file: ${filename}`,
      file_path: filePath,
      preview: {
        note: `Displaying first ${MAX_INLINE_ROWS} rows only.`,
        data: res.rows.slice(0, MAX_INLINE_ROWS)
      }
    };
  }
  
  return res.rows;
}

export async function inspectSchema(dbName: string, tableName?: string) {
  const pool = await poolManager.getPool(dbName);
  if (tableName) {
    const query = `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`;
    const res = await pool.query(query, [tableName]);
    return res.rows;
  } else {
    const query = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    const res = await pool.query(query);
    return res.rows.map(r => r.table_name);
  }
}

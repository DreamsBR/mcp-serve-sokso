import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { fromIni } from "@aws-sdk/credential-providers";
import { DateTime } from "luxon";
import path from "path";

// Log errors to a file for debugging initialization issues
const LOG_FILE = path.join(process.cwd(), "mcp-startup-error.log");
function logError(msg: string) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

process.on("uncaughtException", (error) => {
  logError(`Uncaught Exception: ${error.stack}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logError(`Unhandled Rejection: ${reason}`);
});

// Load .env from a specific path if provided
const dotenvPath = process.env.DOTENV_PATH;
if (dotenvPath) {
  dotenv.config({ path: dotenvPath });
} else {
  dotenv.config();
}

/**
 * PoolManager handles multiple database connections.
 * It loads connections from a JSON file and environment variables.
 */
class PoolManager {
  private pools = new Map<string, pg.Pool>();
  private configs: Record<string, string> = {};

  constructor() {
    this.loadConfigs();
  }

  loadConfigs() {
    const configPath = process.env.MCP_DB_CONFIG_PATH || "databases.json";
    if (fs.existsSync(configPath)) {
      try {
        this.configs = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (error) {
        console.error("Error loading database configs:", error);
      }
    }

    // Fallback or default from .env if variables are present
    if (process.env.DB_HOST && !this.configs["default"]) {
      const connectionString = `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD
        }@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME
        }`;
      this.configs["default"] = connectionString;
    }
  }

  async getPool(name = "default"): Promise<pg.Pool> {
    if (!this.pools.has(name)) {
      // Force reload to get latest databases.json changes
      this.loadConfigs();

      const connectionString = this.configs[name]?.trim();
      if (!connectionString) {
        throw new Error(
          `Configuración '${name}' no encontrada en databases.json. Disponibles: ${Object.keys(
            this.configs
          ).join(", ")}`
        );
      }

      // Habilitar SSL para cualquier host que no sea localhost
      const isLocal =
        connectionString.includes("localhost") ||
        connectionString.includes("127.0.0.1");
      const forceSSL = !isLocal || connectionString.includes("sslmode=require");

      const pool = new pg.Pool({
        connectionString,
        ssl: forceSSL ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 10,
      });

      this.pools.set(name, pool);
    }
    return this.pools.get(name)!;
  }

  async closeAll() {
    for (const pool of this.pools.values()) {
      await pool.end();
    }
  }
}

const poolManager = new PoolManager();
const cloudWatchClient = new CloudWatchLogsClient({
  region: "us-east-1", // Ajustar si es necesario
  credentials: fromIni({ profile: "sokso" }),
});

/**
 * Helper para obtener logs de AWS
 */
async function fetchAWSLogs(
  logGroupName: string,
  startTimeStr: string,
  endTimeStr: string,
  filterPattern?: string
) {
  const tz_peru = "America/Lima";

  // Convertir entrada a Luxon DateTime asumiendo Perú si no tiene offset
  const startDt = startTimeStr.includes("T") || startTimeStr.includes("Z")
    ? DateTime.fromISO(startTimeStr).setZone(tz_peru)
    : DateTime.fromFormat(startTimeStr, "yyyy-MM-dd HH:mm:ss", { zone: tz_peru });

  const endDt = endTimeStr.includes("T") || endTimeStr.includes("Z")
    ? DateTime.fromISO(endTimeStr).setZone(tz_peru)
    : DateTime.fromFormat(endTimeStr, "yyyy-MM-dd HH:mm:ss", { zone: tz_peru });

  const startMs = startDt.toMillis();
  const endMs = endDt.toMillis();

  const allEvents: any[] = [];
  let nextToken: string | undefined;

  do {
    const command: FilterLogEventsCommand = new FilterLogEventsCommand({
      logGroupName,
      startTime: startMs,
      endTime: endMs,
      filterPattern,
      nextToken,
    });

    const response = await cloudWatchClient.send(command);
    if (response.events) {
      allEvents.push(...response.events.map(event => {
        const dt_peru = DateTime.fromMillis(event.timestamp || 0).setZone(tz_peru);
        return {
          timestampLocal: dt_peru.toFormat("yyyy-MM-dd HH:mm:ss"),
          message: event.message,
          logStreamName: event.logStreamName
        };
      }));
    }
    nextToken = response.nextToken;
  } while (nextToken);

  return allEvents;
}

const server = new Server(
  {
    name: "fisioterapia-analytics",
    version: "1.2.1",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Definición de Herramientas
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "inspect_schema",
        description:
          "Lista todas las tablas y sus columnas en la base de datos para entender la estructura.",
        inputSchema: {
          type: "object",
          properties: {
            db: {
              type: "string",
              description:
                "Nombre de la base de datos a inspeccionar (según databases.json). Opcional, usa 'default' por defecto.",
            },
          },
        },
      },
      {
        name: "run_query",
        description:
          "Ejecuta una consulta SQL de lectura (SELECT) en la base de datos.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "La consulta SQL a ejecutar. Solo se permiten SELECTs.",
            },
            db: {
              type: "string",
              description:
                "Nombre de la base de datos donde ejecutar la consulta. Opcional.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "analyze_backorders",
        description:
          "Analiza un array de pedidos para detectar Back Orders (Cantidad > Cantidad Comprometida). Requiere datos previos obtenidos con run_query.",
        inputSchema: {
          type: "object",
          properties: {
            data: {
              type: "string",
              description:
                "Datos de pedidos en formato JSON string. Debe contener: sEstadoEnvioNetsuite, sAccionDirectora, nCantidad, nCantidadComprometida.",
            },
          },
          required: ["data"],
        },
      },
      {
        name: "get_aws_logs",
        description: "Obtiene logs de AWS CloudWatch para un grupo y rango de tiempo (Zona Horaria Perú por defecto).",
        inputSchema: {
          type: "object",
          properties: {
            logGroupName: { type: "string", description: "Nombre del grupo de logs (ej: /ecs/articulos-ms-prod)" },
            startTime: { type: "string", description: "Fecha inicio (Formato YYYY-MM-DD HH:mm:ss o ISO). Se asume America/Lima." },
            endTime: { type: "string", description: "Fecha fin (Formato YYYY-MM-DD HH:mm:ss o ISO). Se asume America/Lima." },
            filterPattern: { type: "string", description: "Patrón de filtrado (opcional)." },
          },
          required: ["logGroupName", "startTime", "endTime"],
        },
      },
      {
        name: "analyze_orders_in_logs",
        description: "Busca actividad de pedidos específicos en múltiples grupos de logs de AWS.",
        inputSchema: {
          type: "object",
          properties: {
            orders: {
              type: "array",
              items: { type: "object" },
              description: "Array de pedidos (debe incluir sIdPedidoDetalle o sSkuProducto y dtFechaPedido)."
            },
            logGroupNames: {
              type: "array",
              items: { type: "string" },
              description: "Lista de grupos de logs a inspeccionar (ej: ['/ecs/articulos-ms-prod', '/ecs/integraciones-ms-prod'])."
            },
          },
          required: ["orders", "logGroupNames"],
        },
      },
    ],
  };
});

// Implementación de Herramientas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const dbName = (request.params.arguments?.db as string) || "default";

  switch (request.params.name) {
    case "inspect_schema": {
      try {
        const pool = await poolManager.getPool(dbName);
        const client = await pool.connect();
        try {
          const tablesResult = await client.query(`
                        SELECT table_name 
                        FROM information_schema.tables 
                        WHERE table_schema = 'public' 
                        AND table_type = 'BASE TABLE';
                    `);
          const schema: Record<string, any[]> = {};
          for (const row of tablesResult.rows) {
            const tableName = row.table_name;
            const columnsResult = await client.query(
              `
                            SELECT column_name, data_type, is_nullable
                            FROM information_schema.columns 
                            WHERE table_schema = 'public' 
                            AND table_name = $1;
                        `,
              [tableName]
            );
            schema[tableName] = columnsResult.rows;
          }
          return {
            content: [{ type: "text", text: JSON.stringify(schema, null, 2) }],
          };
        } finally {
          client.release();
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error inspecting schema (${dbName}): ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
    case "run_query": {
      const query = String(request.params.arguments?.query);
      if (!query.trim().toLowerCase().startsWith("select")) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Solo se permiten consultas SELECT por seguridad.",
            },
          ],
          isError: true,
        };
      }
      try {
        const pool = await poolManager.getPool(dbName);
        const client = await pool.connect();
        try {
          const result = await client.query(query);
          return {
            content: [
              { type: "text", text: JSON.stringify(result.rows, null, 2) },
            ],
          };
        } finally {
          client.release();
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error executing query (${dbName}): ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
    case "analyze_backorders": {
      const dataArg = request.params.arguments?.data;
      let rows: any[] = [];

      try {
        if (typeof dataArg === "string") {
          rows = JSON.parse(dataArg);
        } else if (Array.isArray(dataArg)) {
          rows = dataArg;
        } else {
          throw new Error(
            "El argumento 'data' debe ser un JSON string o un array."
          );
        }

        if (!Array.isArray(rows)) {
          throw new Error("Los datos proporcionados no son un array.");
        }

        // Análisis en código (Application Level)
        const backOrders = rows
          .filter((row: any) => {
            const isEnviado = row.sEstadoEnvioNetsuite === "ENVIADO";
            const isConfirmado = row.sAccionDirectora === "CONFIRMADO";
            const nCantidad = Number(row.nCantidad);
            const nComprometida = Number(row.nCantidadComprometida || 0);

            // Si nCantidadComprometida es 0 o null, y nCantidad > 0, es backorder
            // O si nCantidad > nComprometida
            return isEnviado && isConfirmado && nCantidad > nComprometida;
          })
          .map((row: any) => ({
            ...row,
            cantidad_pendiente:
              Number(row.nCantidad) - Number(row.nCantidadComprometida || 0),
          }));

        return {
          content: [
            { type: "text", text: JSON.stringify(backOrders, null, 2) },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error en analyze_backorders: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
    case "get_aws_logs": {
      const { logGroupName, startTime, endTime, filterPattern } = request.params.arguments as any;
      try {
        const logs = await fetchAWSLogs(logGroupName, startTime, endTime, filterPattern);
        return {
          content: [{ type: "text", text: JSON.stringify(logs, null, 2) }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error fetching AWS logs: ${error.message}` }],
          isError: true,
        };
      }
    }
    case "analyze_orders_in_logs": {
      const { orders, logGroupNames } = request.params.arguments as any;
      try {
        const results = [];
        for (const order of orders) {
          const orderId = order.sIdPedidoDetalle || order.sPedidoId;
          const sku = order.sSkuProducto;
          const orderDate = order.dtFechaPedido;

          if (!orderDate) continue;

          // Ventana de búsqueda: -5 min desde pedido hasta +30 min
          const start = DateTime.fromISO(orderDate).minus({ minutes: 5 }).toFormat('yyyy-MM-dd HH:mm:ss');
          const end = DateTime.fromISO(orderDate).plus({ minutes: 30 }).toFormat('yyyy-MM-dd HH:mm:ss');

          const orderLogs: any[] = [];
          for (const lg of logGroupNames) {
            const pattern = orderId ? `"${orderId}"` : `"${sku}"`;
            const logs = await fetchAWSLogs(lg, start, end, pattern);
            orderLogs.push(...logs.map(l => ({ ...l, logGroup: lg })));
          }

          results.push({
            orderId,
            sku,
            orderDateLocal: DateTime.fromISO(orderDate).setZone('America/Lima').toString(),
            logs: orderLogs,
          });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error analyzing orders in logs: ${error.message}` }],
          isError: true,
        };
      }
    }
    default:
      throw new Error("Tool not found");
  }
});

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (error: any) {
  logError(`Server connection error: ${error.stack}`);
  process.exit(1);
}

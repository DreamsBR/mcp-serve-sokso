import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const LOG_FILE = path.join(process.cwd(), "mcp-server.log");

function log(msg: string) {
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, entry);
  console.log(msg);
}

export class PoolManager {
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
        log(`Error loading database configs: ${error}`);
      }
    }

    if (process.env.DB_HOST && !this.configs["default"]) {
      const connectionString = `postgresql://${process.env.DB_USER}:${
        process.env.DB_PASSWORD
      }@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${
        process.env.DB_NAME
      }`;
      this.configs["default"] = connectionString;
    }
  }

  async getPool(name = "default"): Promise<pg.Pool> {
    if (!this.pools.has(name)) {
      this.loadConfigs();
      const connectionString = this.configs[name]?.trim();
      if (!connectionString) {
        // Fallback for environment variables if defined directly (legacy/simple support)
        if (name === "pedidosproduction" && process.env.DB_PEDIDOSPRODUCTION_URL) {
            return this.createPool(name, process.env.DB_PEDIDOSPRODUCTION_URL);
        }
        
        // Fallback: If 'default' is requested but not found, try 'pedidosproduction'
        if (name === "default" && process.env.DB_PEDIDOSPRODUCTION_URL) {
            return this.createPool(name, process.env.DB_PEDIDOSPRODUCTION_URL);
        }

        throw new Error(
          `Configuración '${name}' no encontrada. Disponibles: ${Object.keys(
            this.configs
          ).join(", ")}`
        );
      }
      return this.createPool(name, connectionString);
    }
    return this.pools.get(name)!;
  }

  private createPool(name: string, connectionString: string): pg.Pool {
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
      return pool;
  }
}

export const poolManager = new PoolManager();

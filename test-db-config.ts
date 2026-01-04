import fs from "fs";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

const configPath = process.env.MCP_DB_CONFIG_PATH || "databases.json";
console.log(`CWD: ${process.cwd()}`);
console.log(`Config path: ${configPath}`);
console.log(`Absolute config path: ${path.resolve(configPath)}`);

if (fs.existsSync(configPath)) {
    console.log("Config file exists.");
    try {
        const rawConfigs = JSON.parse(fs.readFileSync(configPath, "utf8"));
        console.log("Raw configs:", rawConfigs);
        const configs: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawConfigs)) {
            if (typeof value === "string" && value.startsWith("DB_") && process.env[value]) {
                configs[key] = process.env[value]!;
                console.log(`Loaded ${key} from env var ${value}`);
            } else {
                configs[key] = value as string;
                console.log(`Loaded ${key} as literal/unresolved: ${value}`);
            }
        }
        console.log("Final configs keys:", Object.keys(configs));
    } catch (error) {
        console.error("Error parsing JSON:", error);
    }
} else {
    console.error("Config file DOES NOT exist.");
}

import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { fromIni } from "@aws-sdk/credential-providers";
import { DateTime } from "luxon";
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

const cloudWatchClient = new CloudWatchLogsClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: fromIni({ profile: process.env.AWS_PROFILE || "default" }),
});

export async function fetchAWSLogs(
  logGroupName: string,
  startTimeStr: string,
  endTimeStr: string,
  filterPattern?: string
) {
  const tz_peru = "America/Lima";
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

  // Limit to 5 pages to prevent timeouts
  let pages = 0;
  do {
    const command: FilterLogEventsCommand = new FilterLogEventsCommand({
      logGroupName,
      startTime: startMs,
      endTime: endMs,
      filterPattern,
      nextToken,
      limit: 50,
    });

    try {
      const response = await cloudWatchClient.send(command);
      if (response.events) {
        allEvents.push(...response.events.map(event => ({
          timestamp: DateTime.fromMillis(event.timestamp || 0).setZone(tz_peru).toFormat("yyyy-MM-dd HH:mm:ss"),
          message: event.message,
          stream: event.logStreamName
        })));
      }
      nextToken = response.nextToken;
      pages++;
    } catch (err: any) {
      log(`AWS Log Error: ${err.message}`);
      break;
    }
  } while (nextToken && pages < 5);

  return allEvents;
}

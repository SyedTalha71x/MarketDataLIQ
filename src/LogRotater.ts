import fs, { promises as fsPromises } from "fs"
import path from "path";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from '@aws-sdk/lib-storage';
const dotenv = require("dotenv");

dotenv.config();

const config = {
  s3Bucket: process.env.BUCKET_NAME,
  localLogsDir: path.join(__dirname, "../logs"),
  s3BasePath: "logs",
  projectName: "liquidity",
  logFileExtension: ".log",
};

if (!fs.existsSync(config.localLogsDir)) {
  fs.mkdirSync(config.localLogsDir, { recursive: true });
}

if (!process.env.AWS_REGION) {
  throw new Error("AWS_REGION is not defined in the environment variables");
}

if (!process.env.AWS_ACCESS_KEY_ID) {
  throw new Error("AWS_ACCESS_KEY_ID is not defined in the environment variables");
}

if (!process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error("AWS_SECRET_ACCESS_KEY is not defined in the environment variables");
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const uploadToS3 = async (dirname: string, filename: string, filePath: string,) => {
  const fileStream = fs.createReadStream(filePath);

  console.log(`${filePath} is going to be upload `);

  const s3Key = `${config.projectName}/${dirname}/${filename}`;

  if (!config.s3Bucket) {
    throw new Error("S3 bucket name is not defined in the environment variables");
  }

  if (fs.statSync(filePath).size === 0) {
    console.log(`File ${filePath} is empty, skipping upload.`);
    return;
  }

  const params = {
    Bucket: config.s3Bucket,
    Key: s3Key,
    Body: fileStream,
  };

  try {

    try {
      const upload = new Upload({
        client: s3Client,
        params,
      });

      upload.on('httpUploadProgress', (progress) => {
        console.log(`Uploaded ${progress.loaded} bytes of ${progress.total} bytes`);
      });

      await upload.done()
      console.log(`Uploaded ${filename} to S3 at ${s3Key}`);
    } catch (error) {
      await uploadToS3(dirname, filename, filePath);
      return;
    }

    await fsPromises.truncate(filePath, 0);
    console.log(`Truncated local file ${filePath} after upload`);
  } catch (err) {
    console.error(`S3 upload error for ${filename}:`, err);
  }
};

const rotateAllLogs = async () => {
  const date = new Date().toISOString().split("T")[0];

  try {
    const files = await fsPromises.readdir(config.localLogsDir);

    for (const file of files) {
      if (file.endsWith(config.logFileExtension)) {
        const logPath = path.join(config.localLogsDir, file);
        const baseName = path.basename(file, config.logFileExtension);
        const datedLogName = `${date}${config.logFileExtension}`;
        await uploadToS3(baseName, datedLogName, logPath);
      }
    }
  } catch (err) {
    console.error("Error reading logs directory:", err);
  }
};

rotateAllLogs();
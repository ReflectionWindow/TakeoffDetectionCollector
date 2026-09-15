import {
  defineRailway,
  github,
  preserve,
  project,
  service,
} from "railway/iac";

export default defineRailway(() => {
  const collector = service("TakeoffDetectionCollector", {
    source: github("ReflectionWindow/TakeoffDetectionCollector", {
      branch: "main",
      rootDirectory: "TakeoffDetectionCollector/backend",
    }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["/TakeoffDetectionCollector/backend/**"],
    },
    healthcheck: "/health",
    healthcheckTimeout: 60,
    replicas: 1,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      ALLOWED_EMAIL_DOMAIN: "reflectionwindow.com",
      INGEST_WORKERS: "16",
      CLAIM_TTL: "5m",
      DB_MAX_OPEN_CONNS: "16",
      DB_MAX_IDLE_CONNS: "8",
      CORS_ORIGINS: "https://takeoff-detection-collector.vercel.app,https://*.vercel.app",
      DATA_DIR: preserve(),
      SUPABASE_URL: preserve(),
      SUPABASE_ANON_KEY: preserve(),
      SUPABASE_JWT_SECRET: preserve(),
      SUPABASE_SERVICE_ROLE_KEY: preserve(),
      SUPABASE_DB_URL: preserve(),
    },
  });

  return project("DataHarvest", {
    resources: [collector],
  });
});

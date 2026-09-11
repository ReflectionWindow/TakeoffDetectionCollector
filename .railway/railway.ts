import {
  defineRailway,
  github,
  project,
  service,
} from "railway/iac";

export default defineRailway(() => {
  const collector = service("collector", {
    source: github("ReflectionWindow/TakeoffDetectionCollector", {
      branch: "main",
      rootDirectory: "TakeoffDetectionCollector/backend",
      checkSuites: true,
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
      CLAIM_TTL: "24h",
      DB_MAX_OPEN_CONNS: "16",
      DB_MAX_IDLE_CONNS: "8",
    },
  });

  return project("TakeoffDetectionCollector", {
    resources: [collector],
  });
});

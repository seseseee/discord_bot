
module.exports = {
  apps: [
    {
      name: "chatviz-web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      cwd: "./web",
      env: { NODE_ENV: "production" }
    },
    {
      name: "chatviz-analyze",
      script: "node_modules/tsx/dist/cli.js",
      args: "scripts/autoAnalyze.ts",
      cwd: "./web",
      env: { NODE_ENV: "production" }
    },
    {
      name: "chatviz-export",
      script: "node_modules/tsx/dist/cli.js",
      args: "scripts/autoExport.ts",
      cwd: "./web",
      env: { NODE_ENV: "production" }
    }
  ]
};

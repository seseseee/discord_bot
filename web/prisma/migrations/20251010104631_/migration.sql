-- CreateTable
CREATE TABLE "user_profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorIsBot" BOOLEAN NOT NULL,
    "contentText" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "excludedFromMetrics" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_Message" ("authorId", "authorIsBot", "channelId", "contentText", "createdAt", "id", "serverId") SELECT "authorId", "authorIsBot", "channelId", "contentText", "createdAt", "id", "serverId" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE INDEX "Message_serverId_createdAt_idx" ON "Message"("serverId", "createdAt");
CREATE INDEX "Message_serverId_channelId_createdAt_idx" ON "Message"("serverId", "channelId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

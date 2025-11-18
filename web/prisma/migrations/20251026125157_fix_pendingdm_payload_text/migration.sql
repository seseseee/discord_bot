/*
  Warnings:

  - A unique constraint covering the columns `[messageId,userId,label]` on the table `Feedback` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateTable
CREATE TABLE "PendingDM" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "trigger" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "plannedAt" DATETIME NOT NULL,
    "sentAt" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PendingDM_serverId_status_plannedAt_idx" ON "PendingDM"("serverId", "status", "plannedAt");

-- CreateIndex
CREATE INDEX "PendingDM_serverId_userId_status_idx" ON "PendingDM"("serverId", "userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_messageId_userId_label_key" ON "Feedback"("messageId", "userId", "label");

/*
  Warnings:

  - You are about to drop the column `hasMention` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `replyToId` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `threadId` on the `Message` table. All the data in the column will be lost.
  - You are about to alter the column `createdAt` on the `Message` table. The data in that column could be lost. The data in that column will be cast from `DateTime` to `BigInt`.

*/
-- AlterTable
ALTER TABLE "Label" ADD COLUMN "labelsJson" TEXT;
ALTER TABLE "Label" ADD COLUMN "reactionTo" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorIsBot" BOOLEAN NOT NULL DEFAULT false,
    "contentText" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL
);
INSERT INTO "new_Message" ("authorId", "authorIsBot", "channelId", "contentText", "createdAt", "id", "serverId") SELECT "authorId", "authorIsBot", "channelId", "contentText", "createdAt", "id", "serverId" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE INDEX "Message_serverId_channelId_idx" ON "Message"("serverId", "channelId");
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");
CREATE INDEX "Message_authorId_idx" ON "Message"("authorId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Label_label_idx" ON "Label"("label");

-- CreateIndex
CREATE INDEX "Label_reactionTo_idx" ON "Label"("reactionTo");

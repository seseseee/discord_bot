/*
  Warnings:

  - You are about to drop the column `confidence` on the `Feedback` table. All the data in the column will be lost.
  - You are about to drop the column `notes` on the `Feedback` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `Feedback` table. All the data in the column will be lost.
  - Added the required column `authorId` to the `Feedback` table without a default value. This is not possible if the table is not empty.
  - Added the required column `channelId` to the `Feedback` table without a default value. This is not possible if the table is not empty.
  - Added the required column `serverId` to the `Feedback` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "why" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Feedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Feedback" ("createdAt", "id", "label", "messageId") SELECT "createdAt", "id", "label", "messageId" FROM "Feedback";
DROP TABLE "Feedback";
ALTER TABLE "new_Feedback" RENAME TO "Feedback";
CREATE INDEX "Feedback_messageId_idx" ON "Feedback"("messageId");
CREATE INDEX "Feedback_serverId_createdAt_idx" ON "Feedback"("serverId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

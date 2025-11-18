-- CreateIndex
CREATE INDEX "Message_serverId_excludedFromMetrics_createdAt_idx" ON "Message"("serverId", "excludedFromMetrics", "createdAt");

-- CreateIndex
CREATE INDEX "Message_serverId_excludedFromMetrics_authorIsBot_createdAt_idx" ON "Message"("serverId", "excludedFromMetrics", "authorIsBot", "createdAt");

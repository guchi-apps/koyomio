-- タスク本体はNotionに置き、内部APIの再送判定だけをDaySpan DBに保存する。
CREATE TABLE `InternalTaskOperation` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `operation` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NULL,
  `requestHash` VARCHAR(64) NOT NULL,
  `state` VARCHAR(191) NOT NULL DEFAULT 'PROCESSING',
  `result` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `InternalTaskOperation_userId_idempotencyKey_key`(`userId`, `idempotencyKey`),
  INDEX `InternalTaskOperation_userId_taskId_operation_idx`(`userId`, `taskId`, `operation`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `InternalTaskOperation`
  ADD CONSTRAINT `InternalTaskOperation_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Folder`
  ADD COLUMN `isPublic` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `publicToken` VARCHAR(191) NULL,
  ADD COLUMN `publicPermission` ENUM('VIEW', 'EDIT') NOT NULL DEFAULT 'VIEW';

CREATE UNIQUE INDEX `Folder_publicToken_key` ON `Folder`(`publicToken`);
CREATE INDEX `Folder_publicToken_idx` ON `Folder`(`publicToken`);

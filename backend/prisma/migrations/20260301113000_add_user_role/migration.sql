-- Add role column for admin/user authorization.
ALTER TABLE `User`
ADD COLUMN `role` ENUM('ADMIN', 'USER') NOT NULL DEFAULT 'USER';

-- Ensure the first registered user becomes ADMIN.
UPDATE `User` u
JOIN (
  SELECT `id`
  FROM `User`
  ORDER BY `createdAt` ASC, `id` ASC
  LIMIT 1
) first_user
  ON u.`id` = first_user.`id`
SET u.`role` = 'ADMIN';

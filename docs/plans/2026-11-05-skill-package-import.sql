-- Github/市场导入的不可变技能包快照；只增加可空字段，旧技能保持原样。
ALTER TABLE skills
  ADD COLUMN source JSON NULL COMMENT 'GitHub来源与提交版本',
  ADD COLUMN package_files JSON NULL COMMENT '技能目录内的文件快照';

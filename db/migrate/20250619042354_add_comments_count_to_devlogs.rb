class AddCommentsCountToDevlogs < ActiveRecord::Migration[8.0]
  def change
    add_column :devlogs, :comments_count, :integer, default: 0, null: false
  end
end

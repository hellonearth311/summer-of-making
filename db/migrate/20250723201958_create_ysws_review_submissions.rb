class CreateYswsReviewSubmissions < ActiveRecord::Migration[8.0]
  def change
    create_table :ysws_review_submissions do |t|
      t.references :project, null: false, foreign_key: true, index: { unique: true }

      t.timestamps
    end
  end
end

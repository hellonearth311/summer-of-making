class ErrorsController < ApplicationController
 def not_found
   render status: 404
 end

 def internal_server
   render status: 500
 end
end

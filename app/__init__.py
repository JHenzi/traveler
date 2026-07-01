from flask import Flask, render_template
from . import db


def create_app():
    app = Flask(__name__, template_folder='templates', static_folder='../static')
    db.init_db()

    from .routes import bp
    app.register_blueprint(bp)

    @app.errorhandler(404)
    def not_found(e):
        return render_template('error.html',
                               code=404,
                               title='Page Not Found',
                               message='That page doesn\'t exist.',
                               suggestion='Head back to the forecast and try again.'), 404

    @app.errorhandler(500)
    def server_error(e):
        return render_template('error.html',
                               code=500,
                               title='Something Went Wrong',
                               message='An unexpected error occurred on our end.',
                               suggestion='Try refreshing the page. If this keeps happening, the forecast service may be temporarily unavailable.'), 500

    @app.errorhandler(Exception)
    def unhandled(e):
        app.logger.exception('Unhandled exception: %s', e)
        return render_template('error.html',
                               code=500,
                               title='Something Went Wrong',
                               message='An unexpected error occurred.',
                               suggestion='Try refreshing the page.'), 500

    return app

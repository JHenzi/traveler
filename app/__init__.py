from flask import Flask
from . import db


def create_app():
    app = Flask(__name__, template_folder='templates', static_folder='../static')
    db.init_db()

    from .routes import bp
    app.register_blueprint(bp)

    return app

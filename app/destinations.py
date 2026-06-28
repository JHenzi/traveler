import yaml
import os

_YAML_PATH = os.path.join(os.path.dirname(__file__), '..', 'destinations.yml')


def load_destinations():
    with open(_YAML_PATH) as f:
        data = yaml.safe_load(f)
    return data['destinations']

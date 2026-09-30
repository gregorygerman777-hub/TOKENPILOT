"""Static scanner demo. This module is never executed by the scan."""
import subprocess


def preview_command(user_input):
    return subprocess.run(user_input, shell=True, capture_output=True)

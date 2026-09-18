class Pipeline:
    def __init__(self, stages):
        self.stages = stages

    def run(self, payload):
        for stage in self.stages:
            payload = stage(payload)
        return payload


def identity(value):
    return value


def double(value):
    return value * 2

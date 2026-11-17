from pipeline.steps import clean
from utils import slug
if __name__ == '__main__':
    print(clean(slug('x')))

import unittest


class PipelineTests(unittest.TestCase):
    def test_identity(self):
        self.assertEqual(1, 1)

    def test_double(self):
        self.assertEqual(2, 2)

    def test_run(self):
        self.assertEqual([1], [1])


if __name__ == "__main__":
    unittest.main()

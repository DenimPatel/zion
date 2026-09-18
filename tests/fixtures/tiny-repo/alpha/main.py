"""Alpha module: two documented functions, so floors and lit windows are known."""


def documented(a, b):
    """Add two numbers.

    This docstring is long enough to be counted as documentation.
    """
    # A comment also counts toward the documentation ratio.
    return a + b


class Alpha:
    """A class with one documented method and one bare method."""

    def described(self):
        """Return a greeting."""
        return "hello"

    def bare(self):
        return "no docstring"

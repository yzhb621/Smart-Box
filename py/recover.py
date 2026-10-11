"""Resolve an interrupted opening only after physically inspecting the box."""
import argparse
from cloud import StateStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument('--confirmed-opened', action='store_true')
    choice.add_argument('--confirmed-still-locked', action='store_true')
    args = parser.parse_args()
    store = StateStore()
    state = store.load()
    if not state or state.get('phase') != 'opening':
        parser.error('There is no interrupted opening to resolve.')
    state['phase'] = 'opened' if args.confirmed_opened else 'delivered'
    store.save(state)
    print('Recovery recorded. Restart the controller.')


if __name__ == '__main__':
    main()
